import path from "node:path";
import {
  type Context,
  Resource,
  ResourceKind,
  Secret,
  secret
} from "alchemy";
import { createClient } from "@libsql/client/web";
import {
  type LocalLibsqlServer,
  startLocalLibsqlServer
} from "./local";
import { applyMigrations } from "./migrations";
import { TursoPlatformApi } from "./platform-api";
import { needsDatabaseReplacement } from "./replacement";

export {
  type LocalLibsqlServer,
  type LocalLibsqlServerOptions,
  startLocalLibsqlServer
} from "./local";

type DevSettings =
  | {
    /**
     * Whether to use Turso Cloud instead of a local libSQL server.
     * @default false
     **/
    remote: true
  }
  | {
    remote?: false,
    /**
     * Port for the local libSQL HTTP server.
     * @default - first available port from 8080 onward.
     **/
    port?: number,
    /** Directory for local database files, relative to the project root. */
    dataDir?: string
  };

export interface TursoDatabaseProps {
  /**
   * The remote Turso database name. Defaults to Alchemy's scoped physical name.
   * Changing it replaces a remote database.
   */
  name?: string,

  /**
   * The Turso organization or personal-account slug.
   * Defaults to TURSO_ACCOUNT.
   */
  organization?: string,

  /**
   * A Turso Platform API token. Defaults to TURSO_PLATFORM_TOKEN or TURSO_TOKEN.
   * Use `alchemy.secret.env` when setting it explicitly.
   */
  apiToken?: Secret<string>,

  /** The Turso group that will own the database. It must already exist. */
  group?: string,

  /** A directory of numeric-prefix `.sql` migration files. */
  migrations?: string,

  /** Options used while running `alchemy dev`. */
  dev?: DevSettings,

  /**
   * Whether to delete the remote database when this resource is destroyed.
   *
   * @default true
   */
  delete?: boolean
}

interface TursoDatabaseBase {
  /** The remote database name, or the resource ID for a local database. */
  name: string,
  /** The public HTTP base URL for the database. */
  url: string,
  /** Migration files applied by this resource, keyed by filename. */
  migrations: Record<string, string>
}

export interface RemoteTursoDatabase extends TursoDatabaseBase {
  /** True for a Turso Cloud database. */
  remote: true,
  /** The Turso organization or personal-account slug. */
  organization: string,
  /** The Turso group that owns the database. */
  group: string,
  /** Turso's database ID. */
  databaseId: string,
  /** A full-access database token, encrypted in Alchemy state. */
  authToken: Secret<string>
}

export interface LocalTursoDatabase extends TursoDatabaseBase {
  /** False for a local libSQL server. */
  remote: false,
  /** Local databases do not need an auth token. */
  authToken: "",
  /** Directory that holds local database files. */
  localDataDir: string
}

export type TursoDatabase = RemoteTursoDatabase | LocalTursoDatabase;

export function isTursoDatabase(resource: unknown): resource is TursoDatabase {
  return (
    (resource as { [ResourceKind]?: string } | undefined)?.[ResourceKind] ===
    "turso::Database"
  );
}

interface LocalServerEntry {
  dataDir: string,
  requestedPort?: number,
  pending: Promise<LocalLibsqlServer>
}

const localServers = new Map<string, LocalServerEntry>();

/** Create a Turso database using explicit props or the Turso environment variables. */
export async function TursoDatabase(
  id: string,
  props: TursoDatabaseProps = {}
) {
  return await _TursoDatabase(id, props);
}

const _TursoDatabase = Resource(
  "turso::Database",
  {
    // Local servers are process-scoped. Reconcile on each dev run so a
    // previous process being stopped does not leave a stale URL in state.
    alwaysUpdate: true
  },
  async function(
    this: Context<TursoDatabase>,
    id: string,
    props: TursoDatabaseProps
  ) {
    // Alchemy attaches resource metadata to `this.output` before the first
    // create completes. A Turso ID is the marker for a persisted remote DB.
    const remote = !this.scope.local || props.dev?.remote === true;
    if(needsDatabaseReplacement({ phase: this.phase, previous: this.output, remote })) {
      return this.replace();
    }

    const previous = remote && this.output?.remote === true && this.output.databaseId
      ? this.output
      : undefined;

    if(!remote) {
      if(this.phase === "delete") return this.destroy();

      const local = await getLocalServer(this, id, { ...props, dev: { ...props.dev, remote: false } });
      const appliedMigrations = await applyDatabaseMigrations({
        url: local.server.url,
        directory: props.migrations,
        rootDir: this.scope.rootDir,
        previous: this.output?.remote === false ? this.output.migrations : {}
      });
      return {
        remote: false,
        name: id,
        url: local.server.url,
        authToken: "",
        localDataDir: local.dataDir,
        migrations: appliedMigrations
      } as TursoDatabase;
    }

    const generatedName = this.scope.createPhysicalName(id, "-", 64)
      .toLowerCase()
      .replaceAll("_", "-");
    const name = this.phase === "delete"
      ? previous?.name ?? props.name ?? generatedName
      : props.name ?? previous?.name ?? generatedName;
    const group = props.group ?? previous?.group ?? "default";
    if(!/^[a-z0-9-]{1,64}$/.test(name)) {
      throw new Error("Turso database names must contain 1-64 lowercase letters, numbers, or dashes");
    }

    const credentials = resolveCredentials(props);

    if(needsDatabaseReplacement({
      phase: this.phase,
      previous,
      remote,
      name,
      organization: credentials.organization,
      group
    })) {
      return this.replace();
    }

    const api = new TursoPlatformApi(
      credentials.organization,
      credentials.apiToken
    );

    if(this.phase === "delete") {
      if(props.delete !== false) {
        await api.deleteDatabase(name);
      }
      return this.destroy();
    }

    const database = previous
      ? await api.getDatabase(name)
      : await api.createDatabase(name, group);

    const authToken = previous?.authToken ?? secret(
      await api.createDatabaseToken(name),
      `turso:${credentials.organization}:${name}:auth-token`
    );
    const url = `https://${database.Hostname}`;

    const appliedMigrations = await applyDatabaseMigrations({
      url,
      authToken,
      directory: props.migrations,
      rootDir: this.scope.rootDir,
      previous: previous?.migrations ?? {}
    });

    return {
      remote: true,
      organization: credentials.organization,
      group,
      migrations: appliedMigrations,
      name: database.Name,
      databaseId: database.DbId,
      url,
      authToken
    } as TursoDatabase;
  }
);

async function applyDatabaseMigrations(input: {
  url: string,
  authToken?: Secret<string> | "",
  directory: string | undefined,
  rootDir: string,
  previous: Record<string, string>
}) {
  const client = createClient({
    url: input.url,
    ...(input.authToken ? { authToken: unwrapSecret(input.authToken) } : {})
  });
  try {
    return await applyMigrations({
      client,
      directory: input.directory,
      rootDir: input.rootDir,
      previous: input.previous
    });
  } finally {
    client.close();
  }
}

function unwrapSecret(value: Secret<string>): string {
  const unwrapped = Secret.unwrap(value);
  if(typeof unwrapped !== "string") {
    throw new Error("Expected an Alchemy secret containing a string");
  }
  return unwrapped;
}

async function getLocalServer(
  context: Context<TursoDatabase>,
  id: string,
  props: TursoDatabaseProps & { dev?: Exclude<DevSettings, { remote: true }> }
) {
  const dataDir = path.resolve(
    context.scope.rootDir,
    props.dev?.dataDir ?? path.join(context.scope.dotAlchemy, "turso", id)
  );
  const requestedPort = props.dev?.port;
  let entry = localServers.get(dataDir);
  if(entry && entry.requestedPort !== requestedPort) {
    throw new Error(`Local libSQL data directory ${dataDir} is already assigned to another server. Pass a distinct dev.dataDir for TursoDatabase ${id}.`);
  }
  if(!entry) {
    entry = {
      dataDir,
      requestedPort,
      pending: startLocalLibsqlServer({
        port: requestedPort,
        dataDir,
        cacheDir: path.join(context.scope.dotAlchemy, "cache", "libsql-server")
      })
    };
    localServers.set(dataDir, entry);
  }

  let server: LocalLibsqlServer;
  try {
    server = await entry.pending;
  } catch (error) {
    if(localServers.get(dataDir) === entry) localServers.delete(dataDir);
    throw error;
  }

  context.onCleanup(async () => {
    if(localServers.get(dataDir) === entry) {
      localServers.delete(dataDir);
      await server.stop();
    }
  });
  return { server, dataDir };
}

function resolveCredentials(props: TursoDatabaseProps): {
  organization: string,
  apiToken: Secret<string>
} {
  const organization = props.organization ?? process.env.TURSO_ACCOUNT;
  if(!organization) {
    throw new Error("No Turso account found. Set TURSO_ACCOUNT, or pass organization to TursoDatabase.");
  }

  if(props.apiToken) {
    return { organization, apiToken: props.apiToken };
  }

  const apiToken = process.env.TURSO_PLATFORM_TOKEN ?? process.env.TURSO_TOKEN;
  if(!apiToken) {
    throw new Error("No Turso Platform API token found. Set TURSO_PLATFORM_TOKEN or TURSO_TOKEN, or pass apiToken to TursoDatabase.");
  }
  return { organization, apiToken: secret(apiToken, "TURSO_PLATFORM_TOKEN") };
}
