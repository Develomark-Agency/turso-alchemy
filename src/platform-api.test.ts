import { expect, test } from "bun:test";
import { secret } from "alchemy";
import { TursoPlatformApi } from "./platform-api";

test("TursoPlatformApi creates and maps a database", async () => {
  await withFetch(
    async () => {
      return jsonResponse({
        database: { DbId: "db-1", Hostname: "db.turso.io", Name: "app" }
      });
    },
    async () => {
      const database = await new TursoPlatformApi("acme", secret("token", "test"))
        .createDatabase("app", "default");

      expect(database).toEqual({
        DbId: "db-1",
        Hostname: "db.turso.io",
        Name: "app",
        Group: "default"
      });
    }
  );
});

test("TursoPlatformApi gets an existing database after a conflict", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      if(calls === 1) return jsonResponse({ error: "already exists" }, 409);
      return jsonResponse({
        database: {
          DbId: "db-1",
          Hostname: "db.turso.io",
          Name: "app",
          group: "default"
        }
      });
    },
    async () => {
      await expect(
        new TursoPlatformApi("acme", secret("token", "test"))
          .createDatabase("app", "default")
      ).resolves.toMatchObject({ DbId: "db-1", Group: "default" });
      expect(calls).toBe(2);
    }
  );
});

test("TursoPlatformApi ignores a missing database during deletion", async () => {
  await withFetch(
    async () => jsonResponse({ error: "not found" }, 404),
    async () => {
      await expect(
        new TursoPlatformApi("acme", secret("token", "test"))
          .deleteDatabase("app")
      ).resolves.toBeUndefined();
    }
  );
});

test("TursoPlatformApi keeps a failed deletion visible", async () => {
  await withFetch(
    async () => jsonResponse({ error: "forbidden" }, 403),
    async () => {
      await expect(
        new TursoPlatformApi("acme", secret("token", "test"))
          .deleteDatabase("app")
      ).rejects.toMatchObject({ status: 403 });
    }
  );
});

test("TursoPlatformApi keeps an unexpected create failure visible", async () => {
  await withFetch(
    async () => jsonResponse({ error: "forbidden" }, 403),
    async () => {
      await expect(
        new TursoPlatformApi("acme", secret("token", "test"))
          .createDatabase("app", "default")
      ).rejects.toMatchObject({ status: 403 });
    }
  );
});

test("TursoPlatformApi creates a full-access database token", async () => {
  let url: string | undefined;
  await withFetch(
    async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      url = request.url;
      return jsonResponse({ jwt: "database-token" });
    },
    async () => {
      await expect(
        new TursoPlatformApi("acme", secret("token", "test"))
          .createDatabaseToken("app")
      ).resolves.toBe("database-token");
    }
  );

  expect(url).toContain("/databases/app/auth/tokens");
  expect(url).toContain("authorization=full-access");
});

async function withFetch(
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof globalThis.fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
