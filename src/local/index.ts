import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import getPort, { portNumbers } from "get-port";
import { downloadNativeBinary } from "./native";
import {
  dockerIsRunning,
  hasCommand,
  localHost,
  startAndWait,
  startDocker
} from "./process";

const defaultPort = 8080;
const defaultPortRangeEnd = 8099;
const operatingSystem = os.platform();

export interface LocalLibsqlServerOptions {
  /** Directory that holds the local database data. Defaults to `.libsql` in the current directory. */
  dataDir?: string,
  /** Port for the local HTTP server. Defaults to the first available port from 8080 onward. */
  port?: number,
  /** Where macOS and Linux keep the downloaded server. */
  cacheDir?: string
}

export interface LocalLibsqlServer {
  /** The local HTTP URL to give to a libSQL client. */
  url: string,
  /** The launcher selected for this server. */
  launcher: "turso" | "docker" | "native",
  /** Stop the process or remove the Docker container. */
  stop(): Promise<void>
}

/** Start a local libSQL server without requiring a global sqld install. */
export async function startLocalLibsqlServer(options: LocalLibsqlServerOptions = {}) {
  const port = await selectLocalPort(options.port);

  const dataDir = path.resolve(options.dataDir ?? ".libsql");
  await fs.mkdir(dataDir, { recursive: true });

  if(operatingSystem === "win32") return startWindowsServer(dataDir, port);

  if(operatingSystem !== "darwin" && operatingSystem !== "linux") {
    throw new Error(
      `Local libSQL server downloads do not support ${operatingSystem}.`
    );
  }

  const binary = await downloadNativeBinary(options.cacheDir);
  return startAndWait(binary, ["--http-listen-addr", `${localHost}:${port}`], {
    cwd: dataDir,
    launcher: "native",
    port
  });
}

async function startWindowsServer(dataDir: string, port: number) {
  const hasTurso = await hasCommand("turso");

  let tursoError: Error | undefined;
  if(port === defaultPort && hasTurso) {
    try {
      return await startAndWait(
        "turso",
        ["dev", "--db-file", path.join(dataDir, "local.db")],
        { cwd: dataDir, launcher: "turso", port }
      );
    } catch (error) {
      tursoError = asError(error);
    }
  }

  const [hasDocker, dockerRunning] = await Promise.all([
    hasCommand("docker"),
    dockerIsRunning()
  ]);

  if(hasDocker && dockerRunning) {
    try {
      return await startDocker(dataDir, port);
    } catch (error) {
      throw new Error(`Could not start a local libSQL server on Windows. ${tursoError?.message ?? "Docker was available but failed."} ${asError(error).message}`);
    }
  }
  if(tursoError) {
    throw new Error(`Turso CLI could not start libSQL, and Docker is not available as a fallback. ${tursoError.message}. Start Docker Desktop and retry.`);
  }
  if(port !== defaultPort && hasTurso) {
    throw new Error(`Turso CLI runs its local server on port ${defaultPort}. Start Docker Desktop to use port ${port}, or use port ${defaultPort}.`);
  }
  throw new Error("Could not start a local libSQL server on Windows. Install the Turso CLI and retry, or install and start Docker Desktop. Native libSQL server downloads are only supported on macOS and Linux.");
}

export async function selectLocalPort(requestedPort?: number): Promise<number> {
  if(requestedPort !== undefined) {
    validatePort(requestedPort);
    const port = await getPort({ port: requestedPort, host: localHost });
    if(port !== requestedPort) {
      throw new Error(`Cannot start a local libSQL server: port ${requestedPort} is already in use.`);
    }
    return port;
  }
  return await getPort({
    port: portNumbers(defaultPort, defaultPortRangeEnd),
    host: localHost
  });
}

function validatePort(port: number): void {
  if(!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Local libSQL server port must be an integer from 1 to 65535");
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
