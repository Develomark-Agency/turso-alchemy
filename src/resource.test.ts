import { expect, test } from "bun:test";
import { PROVIDERS, secret } from "alchemy";
import "./resource";

test("TursoDatabase deletes a persisted remote database", async () => {
  const originalFetch = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = (async (input, init) => {
    request = input instanceof Request
      ? new Request(input, init)
      : new Request(input.toString(), init);
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;

  const destroyed = { destroyed: true };
  const context = {
    phase: "delete",
    output: {
      remote: true,
      name: "app",
      organization: "acme",
      group: "default",
      databaseId: "db-1",
      migrations: {},
      url: "https://db.turso.io",
      authToken: secret("database-token", "test")
    },
    scope: {
      local: false,
      rootDir: "/",
      dotAlchemy: "/.alchemy",
      createPhysicalName: () => "generated-name"
    },
    destroy: () => destroyed,
    replace: () => {
      throw new Error("replacement was not expected");
    }
  };

  try {
    const provider = PROVIDERS.get("turso::Database");
    if(!provider) throw new Error("TursoDatabase provider was not registered");

    const result = await provider.handler.call(context as never, "app", {
      organization: "acme",
      apiToken: secret("platform-token", "test")
    });
    expect(result).toEqual(destroyed);
    expect(request?.method).toBe("DELETE");
    expect(request?.url).toContain("/databases/app");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
