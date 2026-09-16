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

test("TursoPlatformApi creates a full-access database token", async () => {
  await withFetch(
    async () => jsonResponse({ jwt: "database-token" }),
    async () => {
      await expect(
        new TursoPlatformApi("acme", secret("token", "test"))
          .createDatabaseToken("app")
      ).resolves.toBe("database-token");
    }
  );
});

test("TursoPlatformApi auto-creates a missing group with the closest location", async () => {
  const seen: string[] = [];
  let groupBody: { name?: string, location?: string } | undefined;
  await withFetch(
    async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      seen.push(`${request.method ?? "GET"} ${request.url}`);
      if(request.url === "https://region.turso.io/") {
        return jsonResponse({ server: "iad", client: "iad" });
      }
      if(request.url.includes("/groups/default") && (request.method ?? "GET") === "GET") {
        return jsonResponse({ error: "not found" }, 404);
      }
      if(request.url.includes("/groups") && request.method === "POST") {
        groupBody = await request.json() as { name?: string, location?: string };
        return jsonResponse({ group: { name: "default", primary: "iad" } });
      }
      if(request.url.includes("/databases") && request.method === "POST") {
        return jsonResponse({
          database: { DbId: "db-1", Hostname: "db.turso.io", Name: "app" }
        });
      }
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    },
    async () => {
      const database = await new TursoPlatformApi("acme", secret("token", "test"))
        .createDatabase("app", "default", { createGroup: true });
      expect(database).toMatchObject({ DbId: "db-1", Group: "default" });
    }
  );

  expect(groupBody).toMatchObject({ name: "default", location: "iad" });
  expect(seen.some(url => url.includes("region.turso.io"))).toBe(true);
});

test("TursoPlatformApi uses an explicit group location without closest lookup", async () => {
  let closestCalls = 0;
  let groupBody: { name?: string, location?: string } | undefined;
  await withFetch(
    async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      if(request.url === "https://region.turso.io/") {
        closestCalls++;
        return jsonResponse({ server: "iad", client: "iad" });
      }
      if(request.url.includes("/groups/default") && (request.method ?? "GET") === "GET") {
        return jsonResponse({ error: "not found" }, 404);
      }
      if(request.url.includes("/groups") && request.method === "POST") {
        groupBody = await request.json() as { name?: string, location?: string };
        return jsonResponse({ group: { name: "default", primary: "lhr" } });
      }
      if(request.url.includes("/databases") && request.method === "POST") {
        return jsonResponse({
          database: { DbId: "db-1", Hostname: "db.turso.io", Name: "app" }
        });
      }
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    },
    async () => {
      await new TursoPlatformApi("acme", secret("token", "test"))
        .createDatabase("app", "default", { createGroup: true, location: "lhr" });
    }
  );

  expect(closestCalls).toBe(0);
  expect(groupBody).toMatchObject({ name: "default", location: "lhr" });
});

test("TursoPlatformApi skips group provisioning in strict mode", async () => {
  await withFetch(
    async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      if(request.url.includes("/groups") || request.url.includes("region.turso.io")) {
        throw new Error(`group provisioning was not expected: ${request.url}`);
      }
      return jsonResponse({
        database: { DbId: "db-1", Hostname: "db.turso.io", Name: "app" }
      });
    },
    async () => {
      const database = await new TursoPlatformApi("acme", secret("token", "test"))
        .createDatabase("app", "default", { createGroup: false });
      expect(database).toMatchObject({ DbId: "db-1", Group: "default" });
    }
  );
});

test("TursoPlatformApi treats a group conflict as already existing", async () => {
  let databaseCalls = 0;
  await withFetch(
    async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      if(request.url === "https://region.turso.io/") {
        return jsonResponse({ server: "iad", client: "iad" });
      }
      if(request.url.includes("/groups/default") && (request.method ?? "GET") === "GET") {
        return jsonResponse({ error: "not found" }, 404);
      }
      if(request.url.includes("/groups") && request.method === "POST") {
        return jsonResponse({ error: "group already exists" }, 409);
      }
      if(request.url.includes("/databases") && request.method === "POST") {
        databaseCalls++;
        return jsonResponse({
          database: { DbId: "db-1", Hostname: "db.turso.io", Name: "app" }
        });
      }
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    },
    async () => {
      const database = await new TursoPlatformApi("acme", secret("token", "test"))
        .createDatabase("app", "default", { createGroup: true, location: "iad" });
      expect(database).toMatchObject({ DbId: "db-1" });
      expect(databaseCalls).toBe(1);
    }
  );
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
