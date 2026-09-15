import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadNativeBinary } from "./native";

test("downloadNativeBinary rejects an archive with a bad checksum", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "turso-alchemy-"));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if(calls === 1) return new Response("archive contents");
    return new Response("0".repeat(64));
  }) as unknown as typeof fetch;

  try {
    await expect(downloadNativeBinary(cacheDir)).rejects.toThrow(
      "failed its checksum verification"
    );
    expect(calls).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheDir, { recursive: true, force: true });
  }
});
