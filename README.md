# turso-alchemy

An Alchemy resource for [Turso Cloud](https://turso.tech/) databases.

## Turso Cloud

Set `TURSO_ACCOUNT` and `TURSO_PLATFORM_TOKEN`, then create a resource in your Alchemy program:

```ts
import { TursoDatabase } from "turso-alchemy";

const database = await TursoDatabase("app-db", {
  migrations: "migrations",
});
```

`TURSO_ACCOUNT` is your Turso organization slug or personal account username. You can pass `organization` and `apiToken` directly instead of using environment variables.

By default, the database name includes the Alchemy app name, scopes, resource ID, and stage. Set `name` to use an exact Turso database name instead. The resource output includes `url` and an encrypted `authToken`.

## Local development

During `alchemy dev`, the resource runs a local [libSQL server](https://docs.turso.tech/libsql) by default:

> libSQL is a production-ready fork of SQLite, maintained by Turso.

```ts
const database = await TursoDatabase("app-db", {
  migrations: "migrations",
  dev: { port: 8080 }
});
```

Set `dev.remote: true` to use the Turso Cloud database while developing:

```ts
const database = await TursoDatabase("app-db", {
  dev: { remote: true }
});
```

If `dev.port` is omitted, the package tries ports from 8080 onward and picks the first available one. An explicitly requested port must be available.

On macOS and Linux, the package downloads a pinned libSQL Server binary into Alchemy's cache. On Windows, it uses the Turso CLI or Docker.

## Migrations

Point `migrations` at a directory of `.sql` files. Files run in numeric-prefix order, such as `001-init.sql` and `002-users.sql`. The resource stores a checksum for every applied file and rejects a file that changed after it ran.