import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Client, Value } from "@libsql/client/web";

export type MigrationDatabase = Pick<Client, "execute" | "transaction">;

export async function applyMigrations(input: {
  client: MigrationDatabase,
  directory: string | undefined,
  rootDir: string,
  previous: Record<string, string>
}) {
  if(!input.directory) return input.previous;

  const directory = path.resolve(input.rootDir, input.directory);
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".sql"))
    .map(entry => entry.name)
    .sort(compareMigrationNames);

  await input.client.execute(`
    CREATE TABLE IF NOT EXISTS _alchemy_turso_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL
    )
  `);

  const result = await input.client.execute(
    "SELECT name, checksum FROM _alchemy_turso_migrations"
  );
  const applied = Object.fromEntries(
    result.rows.map((row, rowIndex) => {
      const name = textValue(row[0], rowIndex, 0);
      const checksum = textValue(row[1], rowIndex, 1);
      return [name, checksum];
    })
  );

  for(const name of files) {
    const sql = fs.readFileSync(path.resolve(directory, name), "utf-8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    if(applied[name] === checksum) continue;
    if(applied[name]) {
      throw new Error(`Migration ${name} changed after it was applied`);
    }

    const transaction = await input.client.transaction("write");
    try {
      await transaction.executeMultiple(
        [sql, `INSERT INTO _alchemy_turso_migrations (name, checksum) VALUES (${quoteSqlString(name)}, ${quoteSqlString(checksum)})`].join(";\n")
      );
      await transaction.commit();
    } catch (error) {
      try {
        await transaction.rollback();
      } catch {
        // Preserve the migration error if rollback also fails.
      }
      throw error;
    } finally {
      transaction.close();
    }
    applied[name] = checksum;
  }

  return applied as Record<string, string>;
}

function textValue(
  value: Value | undefined,
  rowIndex: number,
  columnIndex: number
): string {
  if(typeof value !== "string") {
    throw new Error(
      `Expected text at query result row ${rowIndex + 1}, column ${columnIndex + 1}; received ${valueType(value)}`
    );
  }
  return value;
}

function valueType(value: Value | undefined): string {
  if(value === undefined) return "undefined";
  if(value === null) return "null";
  if(value instanceof ArrayBuffer) return "blob";
  if(typeof value === "bigint") return "integer";
  return typeof value;
}

function compareMigrationNames(a: string, b: string) {
  const aPrefix = /^\d+/.exec(a)?.[0];
  const bPrefix = /^\d+/.exec(b)?.[0];
  if(aPrefix && bPrefix) {
    const numericOrder = Number(aPrefix) - Number(bPrefix);
    if(numericOrder !== 0) return numericOrder;
  } else if(aPrefix) {
    return -1;
  } else if(bPrefix) {
    return 1;
  }
  return a.localeCompare(b);
}

function quoteSqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
