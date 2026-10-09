import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { serve } from "@hono/node-server";
import type { Database as DatabaseType } from "better-sqlite3";
import { Hono } from "hono";
import { attestedPathDigest, BwrapPrimeContainedWorker } from "./prime-runs/bwrap-prime-worker.js";
import { PaperclipApiRunIdentityVerifier } from "./prime-runs/paperclip-run-verifier.js";
import { PrimeControlStore } from "./prime-runs/prime-control-store.js";
import { PrimeRunCoordinator } from "./prime-runs/prime-run-coordinator.js";
import { PrimeRunRepository } from "./prime-runs/prime-run-repository.js";
import { mountPrimeRunRoutes } from "./prime-runs/prime-run-routes.js";
import { openDatabase } from "./store/database.js";
import { ownPrimeState } from "./state.js";

interface StandaloneConfig {
  stateRoot: string;
  paperclipApiUrl: string;
  port: number;
  executable: string;
  executableSha256: string;
  runtimeRoot: string;
  runtimeSha256: string;
}
const configKeys = ["stateRoot", "paperclipApiUrl", "port", "executable", "executableSha256", "runtimeRoot", "runtimeSha256"];

export function parseConfig(value: unknown): StandaloneConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...configKeys].sort().join("\0"))
    throw new Error(`Prime BFF config requires exactly: ${configKeys.join(", ")}`);
  const config = value as Record<string, unknown>;
  if (!Number.isInteger(config.port) || (config.port as number) < 1 || (config.port as number) > 65535)
    throw new Error("Prime BFF port must be an explicit TCP port between 1 and 65535");
  for (const key of ["stateRoot", "executable", "runtimeRoot"]) {
    const path = config[key];
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path)
      throw new Error(`Prime BFF ${key} must be an absolute normalized path`);
  }
  for (const key of ["executableSha256", "runtimeSha256"])
    if (typeof config[key] !== "string" || !/^[a-f0-9]{64}$/.test(config[key]))
      throw new Error(`Prime BFF ${key} must be a pinned SHA-256 digest`);
  if (typeof config.paperclipApiUrl !== "string") throw new Error("Paperclip API URL is required");
  // The verifier rejects non-loopback origins, userinfo and URL fragments.
  new PaperclipApiRunIdentityVerifier(config.paperclipApiUrl);
  if (process.platform !== "linux" || process.arch !== "x64" || process.versions.node !== "24.18.0")
    throw new Error("Prime BFF requires Linux x86_64 and Node 24.18.0");
  return config as unknown as StandaloneConfig;
}

async function assertPinnedNative(config: StandaloneConfig): Promise<void> {
  const [runtime, executable, sandbox] = await Promise.all([
    realpath(config.runtimeRoot), realpath(config.executable), realpath("/usr/bin/bwrap"),
  ]);
  if (runtime !== config.runtimeRoot || executable !== config.executable ||
    sandbox !== "/usr/bin/bwrap" || config.stateRoot === runtime ||
    config.stateRoot.startsWith(`${runtime}/`) || runtime.startsWith(`${config.stateRoot}/`))
    throw new Error("Prime native runtime and private state must have distinct canonical roots");
  const location = relative(runtime, executable);
  const [nativeStat, sandboxStat] = await Promise.all([stat(executable), stat(sandbox)]);
  if (!location || location === ".." || location.startsWith("../") ||
    !nativeStat.isFile() || (nativeStat.mode & 0o111) === 0 ||
    !sandboxStat.isFile() || (sandboxStat.mode & 0o111) === 0)
    throw new Error("Pinned Prime executable and bubblewrap must be executable regular files");
  const kernel = await stat(join(runtime, "kernel-env/bin/python"));
  if (!kernel.isFile() || (kernel.mode & 0o111) === 0)
    throw new Error("Pinned Prime runtime lacks its prebuilt Python kernel");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(executable)) digest.update(chunk);
  if (digest.digest("hex") !== config.executableSha256 ||
    await attestedPathDigest(runtime) !== config.runtimeSha256)
    throw new Error("Prime executable or complete native runtime differs from the pinned SHA-256");
}

export async function startStandalone(configPath: string): Promise<{ close(): Promise<void> }> {
  if (!isAbsolute(configPath)) throw new Error("Prime BFF requires an absolute --config path");
  const config = parseConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown);
  await assertPinnedNative(config);
  const state = ownPrimeState(config.stateRoot);
  let db: DatabaseType | undefined;
  try {
    db = openDatabase(join(state.root, "prime-runs.sqlite"));
    const repository = new PrimeRunRepository(db);
    const controlStore = new PrimeControlStore(join(state.root, "prime-controls-v3"), state.secret.toString("hex"));
    const worker = new BwrapPrimeContainedWorker({
      executable: config.executable,
      executableSha256: config.executableSha256,
      runtimeRoot: config.runtimeRoot,
      runtimeSha256: config.runtimeSha256,
      ipcRoot: state.root,
      privatePaths: [state.root],
      repository,
    });
    const coordinator = new PrimeRunCoordinator(
      new PaperclipApiRunIdentityVerifier(config.paperclipApiUrl), worker, repository, undefined, controlStore,
    );
    const app = new Hono();
    mountPrimeRunRoutes(app, coordinator);
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.port });
    let stopping: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (stopping) return stopping;
      const serverClosed = new Promise<void>((done, fail) => {
        server.close((error) => error ? fail(error) : done());
      });
      stopping = (async () => {
        await coordinator.shutdown();
        if ("closeAllConnections" in server) server.closeAllConnections();
        await serverClosed;
        db!.close();
        state.release();
      })();
      return stopping;
    };
    const terminate = () => {
      const deadline = setTimeout(() => {
        console.error("Prime BFF shutdown did not settle; state ownership remains locked");
        process.exit(1);
      }, 30_000);
      void close().then(() => { clearTimeout(deadline); }, (error: unknown) => {
        console.error("Prime BFF shutdown failed; state ownership remains locked", error);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", terminate);
    process.once("SIGTERM", terminate);
    try {
      if (!server.listening) await new Promise<void>((done, fail) => {
        const listening = () => { server.off("error", error); done(); };
        const error = (reason: Error) => { server.off("listening", listening); fail(reason); };
        server.once("listening", listening);
        server.once("error", error);
      });
    } catch (error) {
      process.off("SIGINT", terminate);
      process.off("SIGTERM", terminate);
      if (server.listening) await close();
      throw error;
    }
    return { close: async () => {
      process.off("SIGINT", terminate);
      process.off("SIGTERM", terminate);
      await close();
    } };
  } catch (error) {
    if (db?.open) db.close();
    state.release();
    throw error;
  }
}
