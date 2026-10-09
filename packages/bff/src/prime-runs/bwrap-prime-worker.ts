import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import {
  PRIME_PROVIDER,
  type PrimeRunEvent,
  type PrimeRunRequest,
  type PrimeSettlement,
  primeCanonicalDigest,
} from "@deepextrema/paperclip-primeagent-adapter";
import { createPrimeIpcMount, validatedPrimeIpcRoot, type PrimeIpcMount } from "./prime-ipc-server.js";
import {
  PRIME_MAX_FRAME_BYTES,
  type PrimeRestrictedIpcRequest,
  type PrimeRestrictedIpcResponse,
} from "./prime-restricted-ipc.js";
import { managedWorkspaceAliases, type PrimeContainedWorker } from "./prime-run-port.js";
import type { PrimeRunRepository } from "./prime-run-repository.js";

interface OwnedProcess {
  child: ChildProcessWithoutNullStreams;
  sessionId: string | null;
  ipc: PrimeIpcMount;
  request: PrimeRunRequest;
  localStopped: boolean;
}

export interface BwrapPrimeWorkerOptions {
  executable: string;
  executableSha256: string;
  runtimeRoot: string;
  runtimeSha256: string;
  ipcRoot: string;
  privatePaths: readonly string[];
  repository: PrimeRunRepository;
  bwrap?: string;
  terminateGraceMs?: number;
}

function stableId(request: PrimeRunRequest, sequence: number, kind: string): string {
  return createHash("sha256")
    .update(`${request.operationId}\0${request.turnId}\0${sequence}\0${kind}`)
    .digest("hex");
}

function stableEffectId(request: PrimeRunRequest, toolCallId: string): string {
  return createHash("sha256")
    .update(`${request.operationId}\0${request.turnId}\0tool\0${toolCallId}`)
    .digest("hex");
}

export async function attestedPathDigest(path: string): Promise<string> {
  const root = await lstat(path);
  if (root.isSymbolicLink()) throw new Error("managed runtime input is a symlink");
  if (root.isFile())
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  if (!root.isDirectory())
    throw new Error("managed runtime input is not a regular file or directory");
  const hash = createHash("sha256");
  async function walk(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const child = resolve(directory, entry.name);
      const childStat = await lstat(child);
      if (childStat.isSymbolicLink()) throw new Error("managed runtime input contains a symlink");
      const name = relative(path, child).split(sep).join("/");
      if (childStat.isDirectory()) {
        hash.update(`d\0${name}\0`);
        await walk(child);
      } else if (childStat.isFile()) {
        hash.update(`f\0${name}\0`);
        hash.update(await readFile(child));
      } else throw new Error("managed runtime input contains a special file");
    }
  }
  await walk(path);
  return hash.digest("hex");
}

/** Paperclip skillDirectoryDigest: sorted relative file names and per-file SHA-256, not a directory byte stream. */
export async function attestedSkillDigest(source: string): Promise<string> {
  if ((await realpath(source)) !== source || !(await lstat(source)).isDirectory())
    throw new Error("managed skill must be a canonical directory");
  const files: Array<[string, string]> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !(metadata.isDirectory() || metadata.isFile()))
        throw new Error("managed skill contains an unsafe filesystem entry");
      if (metadata.isDirectory()) await visit(path);
      else
        files.push([
          relative(source, path),
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        ]);
    }
  }
  await visit(source);
  return primeCanonicalDigest(files);
}

async function canonicalPrivatePath(value: string): Promise<string> {
  let ancestor = resolve(value);
  const missing: string[] = [];
  while (true) {
    try {
      await lstat(ancestor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(ancestor.slice(parent.length).replace(/^[/\\]/, ""));
      ancestor = parent;
      continue;
    }
    // A dangling private symlink is not an absent directory and must fail closed.
    return resolve(await realpath(ancestor), ...missing.reverse());
  }
}

export function primeSandboxArguments(
  request: PrimeRunRequest,
  primePath: string,
  runtimeRoot: string,
  ipcDirectory: string,
  privatePaths: readonly string[],
): string[] {
  const workspace = request.workspace.realRoot;
  for (const privatePath of [runtimeRoot, ipcDirectory, ...privatePaths]) {
    if (
      workspace === "/" ||
      privatePath === "/" ||
      workspace === privatePath ||
      privatePath.startsWith(`${workspace}/`) ||
      workspace.startsWith(`${privatePath}/`)
    )
      throw new Error("Prime private mounts overlap the assigned workspace");
  }
  const runtimeRelativeExecutable = relative(runtimeRoot, primePath).split(sep).join("/");
  if (
    !runtimeRelativeExecutable ||
    runtimeRelativeExecutable.startsWith("../") ||
    isAbsolute(runtimeRelativeExecutable)
  )
    throw new Error("Prime executable must be inside its reviewed runtime root");
  const sandboxExecutable = `/opt/paperclip/runtime/${runtimeRelativeExecutable}`;
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/home",
    "--dir",
    "/run",
    "--dir",
    "/run/prime",
    "--dir",
    "/home/prime",
    "--dir",
    "/opt",
    "--dir",
    "/opt/paperclip",
    "--dir",
    "/opt/paperclip/skills",
    "--ro-bind-try",
    "/etc/ssl/certs",
    "/etc/ssl/certs",
    "--setenv",
    "HOME",
    "/home/prime",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "PRIME_AGENT_KERNEL_PYTHON",
    "/opt/paperclip/runtime/kernel-env/bin/python",
    "--setenv",
    "PRIME_AGENT_INSTALL_UV",
    "0",
    "--setenv",
    "PYTHONDONTWRITEBYTECODE",
    "1",
    "--ro-bind",
    runtimeRoot,
    "/opt/paperclip/runtime",
    "--ro-bind",
    ipcDirectory,
    "/run/prime",
    "--bind",
    join(ipcDirectory, "session"),
    "/run/prime/session",
    "--bind",
    join(ipcDirectory, "session-artifacts"),
    "/run/prime/session-artifacts",
    "--bind",
    request.workspace.realRoot,
    request.workspace.realRoot,
  ];
  for (const [index] of request.managedSkills.entries())
    args.push(
      "--ro-bind",
      join(ipcDirectory, "skills", String(index)),
      `/opt/paperclip/skills/${index}`,
    );
  args.push(
    "--ro-bind",
    join(ipcDirectory, "managed-instructions.md"),
    "/opt/paperclip/managed-instructions.md",
    ...managedWorkspaceAliases(request, ipcDirectory).flatMap(({ snapshot, original }) => [
      "--ro-bind",
      snapshot,
      original,
    ]),
    "--chdir",
    request.workspace.realRoot,
    sandboxExecutable,
    "--mode",
    "acp",
    "--managed-manifest",
    "/run/prime/manifest.json",
  );
  return args;
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (!isRunning(child)) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function isRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}
function ownedProcessGroupGone(child: ChildProcessWithoutNullStreams): boolean {
  if (isRunning(child) || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function signalOwnedProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  // A reaped child no longer proves ownership of its reusable numeric group ID.
  if (!isRunning(child)) return;
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // bubblewrap may have moved itself into a new session; target its exact PID below.
    }
  }
  if (isRunning(child)) {
    try {
      child.kill(signal);
    } catch {
      // The owned process already exited between the checks.
    }
  }
}

async function boundedOwnerReceipt<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readOperationStatus(
  ipc: PrimeIpcMount,
  request: PrimeRunRequest,
): Promise<{
  fenced: boolean;
  provider: "settled" | "uncertain";
  governedActions: "settled" | "uncertain";
  outstandingEffects: number;
} | null> {
  try {
    const frames = await boundedOwnerReceipt(ipc.dispatcher.dispatch({
      version: 2,
      authorityDigest: request.authorityDigest,
      operationId: request.operationId,
      requestId: `status:${randomUUID()}`,
      payload: { method: "operation.status" },
    }), 2_000);
    if (frames === null) return null;
    const last = frames[frames.length - 1];
    if (last?.kind !== "result" || last.result.kind !== "operation") return null;
    const result = last.result;
    if (
      typeof result.fenced !== "boolean" ||
      !["settled", "uncertain"].includes(String(result.provider)) ||
      !["settled", "uncertain"].includes(String(result.governedActions)) ||
      !Number.isSafeInteger(result.outstandingEffects)
    )
      return null;
    return result as {
      fenced: boolean;
      provider: "settled" | "uncertain";
      governedActions: "settled" | "uncertain";
      outstandingEffects: number;
    };
  } catch {
    return null;
  }
}

/**
 * Managed Prime ACP worker. It gets a fresh mount/PID/session namespace, one writable
 * workspace, exact read-only managed inputs, an empty home, and no inherited env.
 */
export class BwrapPrimeContainedWorker implements PrimeContainedWorker {
  private readonly owned = new Map<string, OwnedProcess>();
  private readonly bwrap: string;
  private readonly graceMs: number;
  private readonly ipcRoot: string;

  constructor(private readonly options: BwrapPrimeWorkerOptions) {
    this.ipcRoot = validatedPrimeIpcRoot(options.ipcRoot);
    this.bwrap = options.bwrap ?? "/usr/bin/bwrap";
    this.graceMs = options.terminateGraceMs ?? 3_000;
  }

  private async command(
    request: PrimeRunRequest,
    ipcDirectory: string,
  ): Promise<{ executable: string; args: string[] }> {
    const [primePath, runtimeRoot, bwrapPath] = await Promise.all([
      realpath(this.options.executable),
      realpath(this.options.runtimeRoot),
      realpath(this.bwrap),
    ]);
    const operatorHome = homedir();
    const privateLocations = [
      ...this.options.privatePaths,
      ...[
        ".ssh",
        ".gnupg",
        ".aws",
        ".azure",
        ".config",
        ".docker",
        ".kube",
        ".codex",
        ".prime",
        ".pi",
        ".omp",
        ".claude",
        ".gemini",
        ".grok",
        ".netrc",
        ".npmrc",
        ".pypirc",
      ].map((name) => join(operatorHome, name)),
      join(operatorHome, ".local", "share", "keyrings"),
      join(operatorHome, ".local", "share", "prime"),
      join(operatorHome, ".local", "state"),
    ];
    for (const name of [
      "CODEX_HOME",
      "PRIME_AGENT_CODING_AGENT_DIR",
      "PI_CODING_AGENT_DIR",
      "CLAUDE_CONFIG_DIR",
      "GROK_HOME",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_CONFIG",
      "XDG_CONFIG_HOME",
      "AWS_SHARED_CREDENTIALS_FILE",
      "AWS_CONFIG_FILE",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "CLOUDSDK_CONFIG",
      "AZURE_CONFIG_DIR",
      "DOCKER_CONFIG",
      "GH_CONFIG_DIR",
      "GNUPGHOME",
    ]) {
      const value = process.env[name]?.trim();
      if (value)
        privateLocations.push(value.startsWith("~/") ? join(operatorHome, value.slice(2)) : value);
    }
    privateLocations.push(...(process.env.KUBECONFIG?.split(":").filter(Boolean) ?? []));
    const privatePaths = await Promise.all(
      [...new Set(privateLocations)].map(canonicalPrivatePath),
    );
    if (
      (await realpath(request.workspace.realRoot)) !== request.workspace.realRoot ||
      !(await stat(request.workspace.realRoot)).isDirectory()
    )
      throw new Error("Prime workspace is not a canonical directory");
    const args = primeSandboxArguments(request, primePath, runtimeRoot, ipcDirectory, privatePaths);
    if (
      (await realpath(request.managedInstructions.sourcePath)) !==
        request.managedInstructions.sourcePath ||
      (await attestedPathDigest(request.managedInstructions.sourcePath)) !==
        request.managedInstructions.sha256
    )
      throw new Error("managed instructions changed after launch verification");
    for (const skill of request.managedSkills) {
      if (
        (await realpath(skill.path)) !== skill.path ||
        (await attestedSkillDigest(skill.path)) !== skill.sha256
      )
        throw new Error(`managed skill ${skill.key} changed after launch verification`);
    }
    await writeFile(
      join(ipcDirectory, "managed-instructions.md"),
      request.managedInstructions.content,
      { mode: 0o400, flag: "wx" },
    );
    if (
      (await attestedPathDigest(join(ipcDirectory, "managed-instructions.md"))) !==
      request.managedInstructions.sha256
    )
      throw new Error("managed instruction snapshot changed during materialization");
    await mkdir(join(ipcDirectory, "skills"), { mode: 0o700 });
    for (const [index, skill] of request.managedSkills.entries()) {
      const destination = join(ipcDirectory, "skills", String(index));
      await cp(skill.path, destination, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
      });
      if ((await attestedSkillDigest(destination)) !== skill.sha256)
        throw new Error(`managed skill ${skill.key} changed during snapshot materialization`);
    }
    const primeStat = await stat(primePath);
    if (!primeStat.isFile() || (primeStat.mode & 0o111) === 0)
      throw new Error("Prime executable is not an executable regular file");
    const digest = createHash("sha256");
    const { createReadStream } = await import("node:fs");
    await new Promise<void>((resolve, reject) =>
      createReadStream(primePath)
        .on("data", (chunk) => digest.update(chunk))
        .on("error", reject)
        .on("end", resolve),
    );
    if (digest.digest("hex") !== this.options.executableSha256)
      throw new Error("Prime executable digest does not match the pinned binary");
    if ((await attestedPathDigest(runtimeRoot)) !== this.options.runtimeSha256)
      throw new Error("Prime runtime resource digest does not match the pinned tree");
    const kernel = await stat(join(runtimeRoot, "kernel-env/bin/python"));
    if (!kernel.isFile() || (kernel.mode & 0o111) === 0)
      throw new Error("Prime runtime lacks the prebuilt isolated Python kernel");
    return {
      executable: bwrapPath,
      args,
    };
  }

  async *execute(
    request: PrimeRunRequest,
    signal: AbortSignal,
    broker: (request: unknown, purpose: "execute" | "control") => AsyncIterable<unknown>,
  ): AsyncIterable<PrimeRunEvent> {
    signal.throwIfAborted();
    let emitBroker: (
      brokerRequest: PrimeRestrictedIpcRequest,
      frame: PrimeRestrictedIpcResponse,
    ) => void = () => {};
    const ipc = await createPrimeIpcMount({
      root: this.ipcRoot,
      request,
      repository: this.options.repository,
      broker: (frame, purpose) => broker(frame, purpose),
      observeFrame: (brokerRequest, frame) => emitBroker(brokerRequest, frame),
    });
    ipc.dispatcher.enableControlCapability();
    let command: { executable: string; args: string[] };
    try {
      signal.throwIfAborted();
      command = await this.command(request, ipc.directory);
      signal.throwIfAborted();
      if (Date.parse(request.deadlineAt) <= Date.now())
        throw new Error("Prime execute deadline expired during worker preparation");
    } catch (error) {
      await ipc.close();
      throw error;
    }
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {},
    });
    const owned: OwnedProcess = {
      child,
      sessionId: null,
      ipc,
      request,
      localStopped: false,
    };
    this.owned.set(request.operationId, owned);
    let sequence = 0;
    const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "paperclip-primeagent-bff", version: "1" },
      },
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const errors = createInterface({ input: child.stderr, crlfDelay: Infinity });
    const queue: Array<
      | { stream: "stdout" | "stderr"; line: string }
      | { stream: "fatal"; error: Error }
      | {
          stream: "broker";
          brokerRequest: PrimeRestrictedIpcRequest;
          frame: PrimeRestrictedIpcResponse;
        }
    > = [];
    let wake: (() => void) | undefined;
    const push = (stream: "stdout" | "stderr", line: string) => {
      if (Buffer.byteLength(line) > PRIME_MAX_FRAME_BYTES) {
        queue.push({ stream: "fatal", error: new Error("native ACP frame exceeded managed limit") });
        signalOwnedProcess(child, "SIGTERM");
      } else {
        queue.push({ stream, line });
      }
      if (queue.length >= 128) {
        child.stdout.pause();
        child.stderr.pause();
      }
      wake?.();
      wake = undefined;
    };

    emitBroker = (brokerRequest, frame) => {
      if (frame.kind !== "result" ||
        !["effect", "paperclip", "finalization"].includes(String(frame.result.kind))) return;
      queue.push({ stream: "broker", brokerRequest, frame });
      if (queue.length >= 128) {
        child.stdout.pause();
        child.stderr.pause();
      }
      wake?.();
      wake = undefined;
    };
    lines.on("line", (line) => push("stdout", line));
    errors.on("line", (line) => push("stderr", line));
    let phase: "initialize" | "session" | "prompt" = "initialize";
    let operationStatus: {
      provider: "settled" | "uncertain";
      governedActions: "settled" | "uncertain";
      outstandingEffects: number;
    } | null = null;
    let promptResponse: Record<string, unknown> | null = null;
    const pendingEffects = new Set<string>();
    let deadlineExceeded = false;
    let nativeQuiescence = false;
    let nativePromptId: number | null = null;
    let nativeBoundary: "result" | "error" | null = null;
    let nativeSequence = -1;
    let localEffectsSettled = false;
    let committedCheckpoint: { checkpoint: string; checkpointDigest: string } | null = null;
    let stopMarkerFailed = false;
    const assignedEffects = new Map<string, (typeof request.managedMcp.tools)[number]>();
    const deadlineDelay = Math.max(0, Date.parse(request.deadlineAt) - Date.now());
    const deadlineTimer = setTimeout(() => {
      try {
        this.options.repository.markStopping(request.operationId);
      } catch {
        stopMarkerFailed = true;
      }
      ipc.dispatcher.fenceExecution();
      deadlineExceeded = true;
      void ipc.dispatcher.dispatch({
        version: 2,
        authorityDigest: request.authorityDigest,
        operationId: request.operationId,
        requestId: `deadline-stop:${randomUUID()}`,
        payload: { method: "operation.stop" },
      }).catch(() => undefined);
      signalOwnedProcess(child, "SIGTERM");
      wake?.();
      wake = undefined;
    }, deadlineDelay);
    try {
      while (
        (!promptResponse || queue.length > 0) &&
        (isRunning(child) || queue.length > 0) &&
        !signal.aborted &&
        !deadlineExceeded
      ) {
        if (queue.length === 0)
          await new Promise<void>((resolve) => {
            const settle = () => {
              child.off("exit", settle);
              signal.removeEventListener("abort", settle);
              if (wake === settle) wake = undefined;
              resolve();
            };
            wake = settle;
            child.once("exit", settle);
            signal.addEventListener("abort", settle, { once: true });
            if (!isRunning(child) || signal.aborted) settle();
          });
        const item = queue.shift();
        if (!item) continue;
        if (queue.length <= 64) {
          child.stdout.resume();
          child.stderr.resume();
        }
        if (item.stream === "fatal") throw item.error;
        if (item.stream === "broker") {
          const { brokerRequest, frame } = item;
          if (
            frame.kind !== "result" ||
            frame.result.kind !== "effect" ||
            (brokerRequest.payload.method !== "mcp.tools.call" &&
              brokerRequest.payload.method !== "effect.status")
          )
            continue;
          const effect = frame.result;
          const toolCallId = effect.requestId as string;
          const brokerPayload = brokerRequest.payload;
          const originalTool =
            brokerPayload.method === "mcp.tools.call"
              ? request.managedMcp.tools.find(
                  (assigned) =>
                    assigned.connectionId === brokerPayload.connectionId &&
                    assigned.name === brokerPayload.tool,
                )
              : undefined;
          if (originalTool) assignedEffects.set(toolCallId, originalTool);
          const tool = originalTool ?? assignedEffects.get(toolCallId);
          if (brokerRequest.payload.method === "mcp.tools.call" && !tool)
            throw new Error("broker effect escaped the assigned tool");
          if (effect.state === "awaiting_approval") {
            if (
              !tool ||
              typeof effect.invocationId !== "string" ||
              typeof effect.actionRequestId !== "string"
            )
              throw new Error("governed approval receipt is missing original identities");
            sequence += 1;
            yield {
              type: "approval_wait",
              sequence,
              receiptId: stableId(request, sequence, "approval_wait"),
              turnId: request.turnId,
              effectId: stableEffectId(request, toolCallId),
              invocationId: effect.invocationId,
              actionRequestId: effect.actionRequestId,
              interactionId: effect.interactionId as string | null,
              formalApprovalId: effect.formalApprovalId as string | null,
              issueId: request.identity.issueId,
              tool: tool.name,
              argumentsHash: effect.argumentsHash as string,
            };
          } else if (tool && ["completed", "failed"].includes(String(effect.state))) {
            sequence += 1;
            yield {
              type: "tool_effect",
              sequence,
              receiptId: stableId(request, sequence, "broker_effect"),
              turnId: request.turnId,
              effectId: stableEffectId(request, toolCallId),
              toolCallId,
              toolName: tool.name,
              phase: effect.state as "completed" | "failed",
              replaySafe: false,
            };
          }
          continue;
        }
        let payload: Record<string, unknown> | null = null;
        try {
          payload = JSON.parse(item.line) as Record<string, unknown>;
        } catch {
          /* diagnostic line */
        }
        if (!payload) {
          sequence += 1;
          yield {
            type: "log",
            sequence,
            receiptId: stableId(request, sequence, "log"),
            turnId: request.turnId,
            messageId: stableId(request, sequence, "message"),
            stream: item.stream,
            message: item.line,
          };
          continue;
        }
        if (payload.id === 1 && phase === "initialize") {
          phase = "session";
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "session/new",
            params: {
              cwd: request.workspace.realRoot,
              mcpServers: [],
            },
          });
          continue;
        }
        if (payload.id === 2 && phase === "session") {
          const result = payload.result as Record<string, unknown> | undefined;
          if (!result || result.sessionId !== ipc.session.id)
            throw new Error("Prime ACP did not return the assigned native session ID");
          owned.sessionId = result.sessionId;
          sequence += 1;
          yield {
            type: "accepted",
            sequence,
            receiptId: stableId(request, sequence, "accepted"),
            turnId: request.turnId,
            operationId: request.operationId,
            primeSessionId: result.sessionId,
            resumed: ipc.session.resume,
          };
          phase = "prompt";
          send({
            jsonrpc: "2.0",
            id: 3,
            method: "session/prompt",
            params: {
              sessionId: result.sessionId,
              prompt: [{ type: "text", text: request.prompt }],
            },
          });
          continue;
        }
        if (payload.id === 3 && phase === "prompt") {
          promptResponse = payload;
          continue;
        }
        if (payload.method === "session/update") {
          const params = payload.params as Record<string, unknown> | undefined;
          const update = params?.update as Record<string, unknown> | undefined;
          const meta = update?._meta as Record<string, unknown> | undefined;
          const prime = meta?.["ai.primeintellect.prime-agent"] as Record<string, unknown> | undefined;
          if (prime && phase === "prompt") {
            const eventSequence = prime.eventSequence;
            const promptTurnId = prime.promptTurnId;
            if (!Number.isSafeInteger(eventSequence) || (eventSequence as number) <= nativeSequence ||
              !Number.isSafeInteger(promptTurnId))
              throw new Error("native ACP lifecycle sequence is invalid");
            nativeSequence = eventSequence as number;
            if (nativePromptId === null) nativePromptId = promptTurnId as number;
            if (nativePromptId !== promptTurnId)
              throw new Error("native ACP lifecycle escaped its original prompt");
            if (prime.phase === "responseBoundary") {
              if (nativeBoundary !== null || prime.terminalQuiescenceExpected !== true ||
                !["result", "error"].includes(String(prime.outcome)))
                throw new Error("native ACP response boundary is invalid");
              nativeBoundary = prime.outcome as "result" | "error";
            } else if (prime.phase === "terminalQuiescence") {
              const quiescence = prime.quiescence as Record<string, unknown> | undefined;
              if (nativeBoundary === null || prime.outcome !== nativeBoundary ||
                quiescence?.outstandingSubagents !== 0 ||
                quiescence?.remainingAutonomousContinuations !== 0 || nativeQuiescence)
                throw new Error("native ACP terminal quiescence is invalid");
              nativeQuiescence = true;
            }
          }
        }
        if (payload.method !== "session/update") continue;
        const params = payload.params as Record<string, unknown> | undefined;
        const update = params?.update as Record<string, unknown> | undefined;
        if (!update) continue;
        const updateType = update?.sessionUpdate;
        if (updateType === "agent_message_chunk") {
          const content = update?.content as Record<string, unknown> | undefined;
          if (content?.type !== "text" || typeof content.text !== "string")
            throw new Error("Prime ACP assistant message was not text");
          if (!content.text) continue;
          sequence += 1;
          yield {
            type: "message",
            sequence,
            receiptId: stableId(request, sequence, "message"),
            turnId: request.turnId,
            messageId:
              typeof update?.messageId === "string" && update.messageId.length <= 160
                ? update.messageId
                : stableId(request, sequence, "messageId"),
            role: "assistant",
            content: content.text,
          };
          continue;
        }
        if (updateType !== "tool_call" && updateType !== "tool_call_update") continue;
        const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : null;
        if (!toolCallId) continue;
        const completed = update.status === "completed" || update.status === "failed";
        if (completed) pendingEffects.delete(toolCallId);
        else pendingEffects.add(toolCallId);
        sequence += 1;
        yield {
          type: "tool_effect",
          sequence,
          receiptId: stableId(request, sequence, updateType),
          turnId: request.turnId,
          effectId: stableEffectId(request, toolCallId),
          toolCallId,
          toolName: typeof update.title === "string" ? update.title : "prime_tool",
          phase: completed ? (update.status === "failed" ? "failed" : "completed") : "requested",
          replaySafe: false,
        };
      }
    } finally {
      clearTimeout(deadlineTimer);
      if (isRunning(child)) {
        try {
          this.options.repository.markStopping(request.operationId);
        } catch {
          stopMarkerFailed = true;
        }
        ipc.dispatcher.fenceExecution();
        signalOwnedProcess(child, "SIGTERM");
        if (!(await waitForExit(child, this.graceMs))) {
          signalOwnedProcess(child, "SIGKILL");
          await waitForExit(child, this.graceMs);
        }
      }
      owned.localStopped = ownedProcessGroupGone(child);
      operationStatus = await readOperationStatus(ipc, request);
      localEffectsSettled = !ipc.dispatcher.hasPendingRequests &&
        this.options.repository.unsettledEffectCount(request.operationId) === 0;
      if (promptResponse?.result && nativeQuiescence && owned.localStopped &&
        pendingEffects.size === 0 && !signal.aborted && !deadlineExceeded &&
        operationStatus?.provider === "settled" && operationStatus?.governedActions === "settled" &&
        operationStatus.outstandingEffects === 0 && localEffectsSettled &&
        ipc.dispatcher.hasTerminalProviderReceipt) {
        try { committedCheckpoint = await ipc.session.commit(stableId(request, sequence + 1, "terminal")); }
        catch { /* A failed native checkpoint cannot become a successful terminal. */ }
      }
      await ipc.close();
      this.owned.delete(request.operationId);
    }
    const localStopped = owned.localStopped;
    const settlement: PrimeSettlement = {
      provider:
        operationStatus?.provider === "settled" && ipc.dispatcher.hasTerminalProviderReceipt
          ? "settled"
          : "uncertain",
      worker: localStopped ? "stopped" : "uncertain",
      descendants: localStopped && pendingEffects.size === 0 ? "stopped" : "uncertain",
      governedActions:
        localEffectsSettled && operationStatus?.governedActions === "settled" &&
        operationStatus.outstandingEffects === 0
          ? "settled"
          : "uncertain",
      evidence: [
        ...(stopMarkerFailed ? ["local stop-marker write failed"] : []),
        ...(operationStatus === null ? [] : ["Paperclip durable operation.status receipt"]),
        ...(ipc.dispatcher.hasTerminalProviderReceipt
          ? ["correlated Paperclip provider terminal event"]
          : []),
        ...(localStopped ? ["owned bubblewrap process group exited"] : []),
      ],
    };
    const error = promptResponse?.error;
    const result = promptResponse?.result as Record<string, unknown> | undefined;
    const stopReason = typeof result?.stopReason === "string" ? result.stopReason : null;
    const fullySettled =
      settlement.provider === "settled" &&
      settlement.governedActions === "settled" &&
      settlement.worker === "stopped" &&
      settlement.descendants === "stopped";
    const outcome = !fullySettled
      ? ("uncertain" as const)
      : signal.aborted || stopReason === "cancelled"
        ? ("cancelled" as const)
        : error !== undefined ||
          stopReason === "max_tokens" ||
          stopReason === "max_turn_requests" ||
          stopReason === "refusal"
        ? ("failed" as const)
        : stopReason === "end_turn" && nativeQuiescence && committedCheckpoint !== null
            ? ("completed" as const)
            : ("uncertain" as const);
    sequence += 1;
    const receiptId = stableId(request, sequence, "terminal");
    yield {
      type: "terminal",
      sequence,
      receiptId,
      turnId: request.turnId,
      outcome,
      summary:
        outcome === "completed"
          ? "Prime ACP turn settled"
          : outcome === "cancelled"
            ? "Prime ACP turn was cancelled"
            : outcome === "failed"
              ? `Prime ACP turn stopped: ${stopReason ?? "protocol error"}`
              : deadlineExceeded
                ? "Prime ACP turn exceeded its Paperclip deadline"
                : "Prime ACP turn did not settle",
      errorCode:
        outcome === "completed" || outcome === "cancelled"
          ? null
          : outcome === "failed"
            ? "prime_turn_failed"
            : "prime_worker_uncertain",
      usage: ipc.dispatcher.usage,
      session: {
        version: 3,
        ...request.identity,
        workspaceId: request.workspace.id,
        executionWorkspaceId: request.workspace.executionWorkspaceId,
        workspaceRoot: request.workspace.realRoot,
        namespace: request.authority.session.namespace,
        model: request.model.id,
        connectionId: request.authority.selection.connectionId,
        primeSessionId: owned.sessionId ?? ipc.session.id,
        checkpoint: committedCheckpoint?.checkpoint ?? null,
        checkpointDigest: committedCheckpoint?.checkpointDigest ?? null,
        lastReceiptId: receiptId,
      },
      route: { provider: PRIME_PROVIDER, model: request.model.id, billingType: "subscription" },
      finalization: outcome === "completed" ? ipc.dispatcher.finalization : null,
      settlement,
    };
  }

  async cancel(operationId: string): Promise<PrimeSettlement | "not_found"> {
    const owned = this.owned.get(operationId);
    if (!owned) return "not_found";
    owned.ipc.dispatcher.fenceExecution();
    let stopReceipt = false;
    // Start original-owner control without making local shutdown depend on its response.
    const stopping = owned.ipc.dispatcher
      .dispatch({
        version: 2,
        authorityDigest: owned.request.authorityDigest,
        operationId,
        requestId: `stop:${randomUUID()}`,
        payload: { method: "operation.stop" },
      })
      .then(
        (frames) => {
          stopReceipt = frames.some(
            (frame) =>
              frame.kind === "result" && frame.result.kind === "operation" && frame.result.fenced,
          );
        },
        () => {
          // Durable local fence remains in force; remote outcome is uncertain.
        },
      );
    if (owned.sessionId && isRunning(owned.child))
      owned.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: owned.sessionId } })}\n`,
      );
    signalOwnedProcess(owned.child, "SIGTERM");
    if (!(await waitForExit(owned.child, this.graceMs))) {
      signalOwnedProcess(owned.child, "SIGKILL");
      await waitForExit(owned.child, this.graceMs);
    }
    owned.localStopped = ownedProcessGroupGone(owned.child);
    await boundedOwnerReceipt(stopping, this.graceMs);
    const status = await readOperationStatus(owned.ipc, owned.request);
    const localEffectsSettled = !owned.ipc.dispatcher.hasPendingRequests &&
      this.options.repository.unsettledEffectCount(operationId) === 0;
    return {
      provider:
        status?.fenced === true && status.provider === "settled" &&
        owned.ipc.dispatcher.hasTerminalProviderReceipt
          ? "settled"
          : "uncertain",
      worker: owned.localStopped ? "stopped" : "uncertain",
      descendants: owned.localStopped ? "stopped" : "uncertain",
      governedActions:
        status?.fenced === true && localEffectsSettled &&
        status.governedActions === "settled" && status.outstandingEffects === 0
          ? "settled"
          : "uncertain",
      evidence: [
        ...(stopReceipt ? ["Paperclip operation.stop durable receipt"] : []),
        ...(status?.fenced ? ["Paperclip original-owner fenced operation.status receipt"] : []),
        ...(owned.localStopped ? ["owned bubblewrap process group exited"] : []),
      ],
    };
  }

  async reconcile(operationId: string): Promise<PrimeSettlement | "not_found"> {
    const owned = this.owned.get(operationId);
    if (!owned) return "not_found";
    const status = await readOperationStatus(owned.ipc, owned.request);
    const localEffectsSettled = !owned.ipc.dispatcher.hasPendingRequests &&
      this.options.repository.unsettledEffectCount(operationId) === 0;
    const stopped = owned.localStopped && ownedProcessGroupGone(owned.child);
    return {
      provider:
        status?.fenced === true && status.provider === "settled" &&
        owned.ipc.dispatcher.hasTerminalProviderReceipt
          ? "settled"
          : "uncertain",
      worker: stopped ? "stopped" : "uncertain",
      descendants: stopped ? "stopped" : "uncertain",
      governedActions:
        status?.fenced === true && localEffectsSettled &&
        status.governedActions === "settled" && status.outstandingEffects === 0
          ? "settled"
          : "uncertain",
      evidence: [
        ...(status?.fenced ? ["Paperclip original-owner fenced operation.status receipt"] : []),
        ...(stopped ? ["owned bubblewrap process group exited"] : []),
      ],
    };
  }
}
