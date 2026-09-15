import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCommand } from "./process";

const libsqlServerVersion = "0.24.32";
const releaseBaseUrl = `https://github.com/tursodatabase/libsql/releases/download/libsql-server-v${libsqlServerVersion}`;

export async function downloadNativeBinary(cacheDir?: string) {
  const target = nativeTarget();
  const root = path.resolve(
    cacheDir ?? path.join(os.homedir(), ".cache", "alchemy", "libsql-server"),
    libsqlServerVersion,
    target
  );
  const binary = path.join(root, "sqld");

  if(await exists(binary)) return binary;

  await fs.mkdir(root, { recursive: true });
  const archiveName = `libsql-server-${target}.tar.xz`;
  const archiveUrl = `${releaseBaseUrl}/${archiveName}`;
  const response = await fetch(archiveUrl);
  if(!response.ok || !response.body) {
    throw new Error(`Could not download libSQL server for ${target}: ${response.status} ${response.statusText}`);
  }
  const content = Buffer.from(await response.arrayBuffer());

  const checksumResponse = await fetch(`${archiveUrl}.sha256`);
  if(!checksumResponse.ok) {
    throw new Error(`Could not download the libSQL server checksum for ${target}.`);
  }
  const expected = (await checksumResponse.text())
    .match(/[a-fA-F0-9]{64}/)?.[0]
    ?.toLowerCase();
  const actual = crypto.createHash("sha256").update(content).digest("hex");
  if(!expected || actual !== expected) {
    throw new Error("Downloaded libSQL server failed its checksum verification.");
  }

  const temporaryDir = path.join(root, `.download-${crypto.randomUUID()}`);
  const temporaryArchive = path.join(temporaryDir, archiveName);
  try {
    await fs.mkdir(temporaryDir);
    await fs.writeFile(temporaryArchive, content);
    try {
      await runCommand("tar", ["-xJf", temporaryArchive, "-C", temporaryDir]);
    } catch (error) {
      throw new Error(`Could not unpack libSQL server: ${error instanceof Error ? error.message : String(error)}`);
    }

    const extracted = path.join(temporaryDir, `libsql-server-${target}`, "sqld");
    await fs.rename(extracted, binary);
    await fs.chmod(binary, 0o755);
    return binary;
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
}

function nativeTarget() {
  const operatingSystem = os.platform();
  const system = operatingSystem === "darwin" ? "apple-darwin" : "unknown-linux-gnu";
  const machine = os.arch() === "arm64" ? "aarch64" : os.arch() === "x64" ? "x86_64" : undefined;

  if(!machine) throw new Error(`No libSQL server download exists for ${operatingSystem} ${os.arch()}.`);
  return `${machine}-${system}`;
}

async function exists(path: string) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
