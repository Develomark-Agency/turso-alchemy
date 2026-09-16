import {
  createClient,
  type Database,
  type LocationKeys
} from "@tursodatabase/api";
import { Secret } from "alchemy";

interface PlatformDatabase {
  DbId: string,
  Hostname: string,
  Name: string,
  Group?: string
}

/**
 * Literal Turso region codes (e.g. `"iad"`, `"lhr"`).
 *
 * Derived from the SDK's `LocationKeys` with the `[key: string]: string`
 * index signature stripped — without stripping, `keyof LocationKeys`
 * collapses to `string | number` and editors lose completions.
 */
export type TursoLocationCode = keyof {
  [K in keyof LocationKeys as string extends K
    ? never
    : number extends K
      ? never
      : K]: true
};

/**
 * A Turso region code, `"closest"` for auto-detection, or any custom string.
 * The `string & {}` tail keeps the type open while preserving literal
 * completions in editors.
 */
export type GroupLocation = TursoLocationCode | "closest" | (string & {});

export class TursoPlatformApi {
  private readonly client;
  private readonly organization;
  private readonly apiToken;

  constructor(
    organization: string,
    apiToken: Secret<string>
  ) {
    this.organization = organization;
    this.apiToken = apiToken;

    this.client = createClient({
      org: organization,
      token: async () => unwrapSecret(apiToken)
    });
  }

  async createDatabase(
    name: string,
    group: string,
    options?: { createGroup?: boolean, location?: GroupLocation }
  ) {
    if(options?.createGroup) {
      await this.ensureGroup(group, options.location);
    }
    try {
      const database = await this.client.databases.create(name, { group });
      return mapCreatedDatabase(database, group);
    } catch (error) {
      if(isStatus(error, 409)) return this.getDatabase(name);
      throw error;
    }
  }

  async ensureGroup(name: string, location?: GroupLocation) {
    try {
      await this.client.groups.get(name);
      return;
    } catch (error) {
      if(!isStatus(error, 404)) throw error;
    }

    const primaryLocation = await this.resolveLocation(location);
    try {
      await this.client.groups.create(name, primaryLocation);
    } catch (error) {
      if(isStatus(error, 409)) return;
      if(isStatus(error, 402) || isStatus(error, 403)) {
        throw new Error(
          `Could not create Turso group ${JSON.stringify(name)}. Creating more than one group requires a Scaler, Pro, or Enterprise plan. Create the database in an existing group instead.`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  async resolveLocation(location?: GroupLocation): Promise<keyof LocationKeys> {
    if(location && location !== "closest") {
      return location as keyof LocationKeys;
    }
    try {
      const closest = await this.client.locations.closest();
      if(!closest?.server || typeof closest.server !== "string") {
        throw new Error(`Unexpected closest-region response: ${JSON.stringify(closest)}`);
      }
      return closest.server;
    } catch (error) {
      throw new Error(
        "Could not determine the closest Turso region. Pass an explicit group location, e.g. group: { createIfMissing: true, location: \"iad\" }.",
        { cause: error }
      );
    }
  }

  async getDatabase(name: string) {
    const database = await this.client.databases.get(name);
    return mapDatabase(database);
  }

  async createDatabaseToken(name: string) {
    const token = await this.client.databases.createToken(name, {
      authorization: "full-access"
    });
    return token.jwt;
  }

  async deleteDatabase(name: string) {
    try {
      await this.client.databases.delete(name);
    } catch (error) {
      if(!isStatus(error, 404)) throw error;
    }
  }
}

function mapCreatedDatabase(
  database: { id: string, hostname: string, name: string },
  group: string
) {
  return {
    DbId: database.id,
    Hostname: database.hostname,
    Name: database.name,
    Group: group
  } as PlatformDatabase;
}

function mapDatabase(database: Database) {
  return {
    DbId: database.id,
    Hostname: database.hostname,
    Name: database.name,
    Group: database.group
  } as PlatformDatabase;
}

function isStatus(error: unknown, status: number) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === status
  );
}

function unwrapSecret(value: Secret<string>) {
  const unwrapped = Secret.unwrap(value);
  if(typeof unwrapped !== "string") {
    throw new Error("Expected an Alchemy secret containing a string");
  }
  return unwrapped;
}
