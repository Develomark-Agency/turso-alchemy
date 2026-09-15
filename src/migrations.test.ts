import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import type { Transaction } from "@libsql/client/web";
import { applyMigrations, type MigrationDatabase } from "./migrations";

test("applyMigrations runs numeric migration names in numeric order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turso-alchemy-"));
  try {
    await writeFile(join(directory, "10-ten.sql"), "SELECT 'ten'");
    await writeFile(join(directory, "2-two.sql"), "SELECT 'two'");
    await writeFile(join(directory, "notes.sql"), "SELECT 'notes'");

    const client = new FakeMigrationDatabase();
    await applyMigrations({ client, directory, rootDir: "/", previous: {} });

    expect(client.sequences).toHaveLength(3);
    expect(client.sequences[0]).toContain("SELECT 'two'");
    expect(client.sequences[1]).toContain("SELECT 'ten'");
    expect(client.sequences[2]).toContain("SELECT 'notes'");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("applyMigrations rejects a migration whose stored checksum changed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turso-alchemy-"));
  try {
    await writeFile(join(directory, "001-init.sql"), "SELECT 1");
    const client = new FakeMigrationDatabase([["001-init.sql", "old-checksum"]]);

    await expect(
      applyMigrations({ client, directory, rootDir: "/", previous: {} })
    ).rejects.toThrow("changed after it was applied");
    expect(client.sequences).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("applyMigrations skips a migration with its stored checksum", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turso-alchemy-"));
  try {
    const sql = "SELECT 1";
    await writeFile(join(directory, "001-init.sql"), sql);
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    const client = new FakeMigrationDatabase([["001-init.sql", checksum]]);

    await expect(
      applyMigrations({ client, directory, rootDir: "/", previous: {} })
    ).resolves.toEqual({ "001-init.sql": checksum });
    expect(client.transactionCalls).toEqual([]);
    expect(client.sequences).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("applyMigrations commits and closes a successful migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turso-alchemy-"));
  try {
    await writeFile(join(directory, "001-init.sql"), "SELECT 1");
    const client = new FakeMigrationDatabase();

    await applyMigrations({ client, directory, rootDir: "/", previous: {} });

    expect(client.transactionCalls).toEqual(["commit", "close"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("applyMigrations rolls back and closes a failed migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turso-alchemy-"));
  try {
    await writeFile(join(directory, "001-init.sql"), "SELECT 1");
    const client = new FakeMigrationDatabase([], true);

    await expect(
      applyMigrations({ client, directory, rootDir: "/", previous: {} })
    ).rejects.toThrow("migration failed");
    expect(client.transactionCalls).toEqual(["rollback", "close"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("applyMigrations preserves the migration error when rollback fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turso-alchemy-"));
  try {
    await writeFile(join(directory, "001-init.sql"), "SELECT 1");
    const client = new FakeMigrationDatabase([], true, true);

    await expect(
      applyMigrations({ client, directory, rootDir: "/", previous: {} })
    ).rejects.toThrow("migration failed");
    expect(client.transactionCalls).toEqual(["rollback", "close"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class FakeMigrationDatabase implements MigrationDatabase {
  readonly sequences: string[] = [];
  readonly transactionCalls: string[] = [];

  constructor(
    private readonly rows: string[][] = [],
    private readonly failMigration = false,
    private readonly failRollback = false
  ) {}

  async execute(sql: string) {
    if(sql.includes("SELECT name, checksum")) {
      return { rows: this.rows } as never;
    }
    return { rows: [] } as never;
  }

  async transaction(): Promise<Transaction> {
    return {
      execute: async () => ({ rows: [] }),
      batch: async () => [],
      executeMultiple: async (sql: string) => {
        if(this.failMigration) throw new Error("migration failed");
        this.sequences.push(sql);
      },
      commit: async () => {
        this.transactionCalls.push("commit");
      },
      rollback: async () => {
        this.transactionCalls.push("rollback");
        if(this.failRollback) throw new Error("rollback failed");
      },
      close: () => {
        this.transactionCalls.push("close");
      },
      closed: false
    } as unknown as Transaction;
  }
}
