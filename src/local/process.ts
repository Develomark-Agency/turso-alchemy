import $, { CommandBuilder, type CommandChild } from "dax";
import crypto from "node:crypto";
import type { LocalLibsqlServer } from "./index";

export const localHost = "127.0.0.1";

export async function hasCommand(command: string): Promise<boolean> {
  return await $.commandExists(command);
}

export async function dockerIsRunning(): Promise<boolean> {
  try {
    await runCommand("docker", ["info"]);
    return true;
  } catch {
    return false;
  }
}

export async function startDocker(
  dataDir: string,
  port: number
): Promise<LocalLibsqlServer> {
  const name = `local-libsql-${crypto.randomUUID()}`;
  try {
    await runCommand("docker", [
      "run",
      "--detach",
      "--name",
      name,
      "--publish",
      `${localHost}:${port}:8080`,
      "--mount",
      `type=bind,src=${dataDir},dst=/var/lib/sqld`,
      "ghcr.io/tursodatabase/libsql-server:latest"
    ]);
  } catch (error) {
    throw new Error(`Docker could not start libSQL: ${commandError(error)}`);
  }

  try {
    await waitForServer(port, `Docker container ${name}`);
  } catch (error) {
    await removeDockerContainer(name);
    throw error;
  }

  return {
    url: `http://${localHost}:${port}`,
    launcher: "docker",
    async stop() {
      await removeDockerContainer(name);
    }
  };
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string } = {}
): Promise<void> {
  let builder = commandBuilder(command, args);
  if(options.cwd) builder = builder.cwd(options.cwd);
  await builder.quiet().errorTail();
}

export async function startAndWait(
  command: string,
  args: string[],
  input: { cwd: string, launcher: "turso" | "native", port: number }
): Promise<LocalLibsqlServer> {
  const child = commandBuilder(command, args)
    .cwd(input.cwd)
    .stdout("null")
    .stderr("piped")
    .spawn();
  const state: ProcessState = { done: false };
  const completion = child.then(
    result => {
      state.done = true;
      state.exitCode = result.code;
    },
    error => {
      state.done = true;
      state.error = error;
    }
  );
  void captureStderr(child.stderr(), chunk => {
    state.stderr = `${state.stderr ?? ""}${chunk}`.slice(-4_000);
  });

  try {
    await waitForServer(input.port, command, state);
  } catch (error) {
    await stopChild(child, completion, state);
    throw error;
  }

  return {
    url: `http://${localHost}:${input.port}`,
    launcher: input.launcher,
    async stop() {
      await stopChild(child, completion, state);
    }
  };
}

interface ProcessState {
  done: boolean,
  exitCode?: number,
  error?: unknown,
  stderr?: string
}

function commandBuilder(command: string, args: string[]): CommandBuilder {
  return new CommandBuilder().command([command, ...args]);
}

async function removeDockerContainer(name: string): Promise<void> {
  try {
    await runCommand("docker", ["rm", "--force", name]);
  } catch (error) {
    if(!(await dockerContainerExists(name))) return;
    throw new Error(`Docker could not stop libSQL: ${commandError(error)}`);
  }
}

async function dockerContainerExists(name: string): Promise<boolean> {
  try {
    await runCommand("docker", ["container", "inspect", name]);
    return true;
  } catch {
    return false;
  }
}

async function stopChild(
  child: CommandChild,
  completion: Promise<void>,
  state: ProcessState
): Promise<void> {
  if(!state.done) child.kill("SIGTERM");
  if(await waitForCompletion(completion, 5_000)) return;
  child.kill("SIGKILL");
  if(!(await waitForCompletion(completion, 5_000))) {
    throw new Error("libSQL server did not exit after SIGKILL");
  }
}

async function waitForCompletion(
  completion: Promise<void>,
  timeout: number
): Promise<boolean> {
  return await Promise.race([
    completion.then(() => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), timeout))
  ]);
}

async function captureStderr(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while(true) {
      const result = await reader.read();
      if(result.done) {
        const remainder = decoder.decode();
        if(remainder) onChunk(remainder);
        return;
      }
      onChunk(decoder.decode(result.value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

async function waitForServer(
  port: number,
  source: string,
  state?: ProcessState
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while(Date.now() < deadline) {
    if(state?.done) {
      throw new Error(
        `${source} exited before libSQL was ready: ${state.stderr?.trim() || commandError(state.error) || `exit code ${state.exitCode}`}`
      );
    }
    try {
      await fetch(`http://${localHost}:${port}`, { signal: AbortSignal.timeout(500) });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`${source} did not accept connections on http://${localHost}:${port} within 15 seconds.`);
}

function commandError(error: unknown): string {
  if(typeof error === "object" && error !== null) {
    const result = error as {
      stderr?: unknown,
      stdout?: unknown,
      message?: unknown
    };
    if(typeof result.stderr === "string" && result.stderr.trim()) return result.stderr.trim();
    if(typeof result.stdout === "string" && result.stdout.trim()) return result.stdout.trim();
    if(typeof result.message === "string") return result.message;
  }
  return String(error);
}
