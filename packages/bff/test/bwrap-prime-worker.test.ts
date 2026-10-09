import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Text } from "@deepextrema/paperclip-primeagent-adapter"
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attestedPathDigest,
  attestedSkillDigest,
  BwrapPrimeContainedWorker,
} from "../src/prime-runs/bwrap-prime-worker.js";
import { createPrimeIpcMount } from "../src/prime-runs/prime-ipc-server.js";
import { PrimeRunRepository } from "../src/prime-runs/prime-run-repository.js";
import { openDatabase } from "../src/store/database.js";
import { finalAuthority, launch } from "./prime-test-authority.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(script: string, managedInWorkspace = false, deadlineMs = 20_000) {
  // Keep the fixture root short enough that tests of later admission guards do
  // not fail first on the production Unix-socket pathname limit.
  const root = await mkdtemp(join(tmpdir(), "pc-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const runtimeRoot = join(root, "runtime");
  const executable = join(runtimeRoot, "fake-acp-worker");
  const kernel = join(runtimeRoot, "kernel-env/bin/python");
  const managedRoot = join(workspace, "managed");
  const instructions = managedInWorkspace
    ? join(managedRoot, "instructions.md")
    : join(root, "instructions.md");
  const skillPath = join(managedRoot, "skill");
  await Promise.all([
    mkdir(workspace),
    mkdir(outside),
    mkdir(join(runtimeRoot, "kernel-env/bin"), { recursive: true }),
  ]);
  if (managedInWorkspace) {
    await Promise.all([
      mkdir(skillPath, { recursive: true }),
      writeFile(join(workspace, "marker.txt"), "writable"),
    ]);
    await writeFile(join(skillPath, "SKILL.md"), "assigned skill");
  }
  await writeFile(executable, script);
  await writeFile(kernel, "#!/bin/sh\nexit 0\n");
  await writeFile(instructions, "managed");
  await Promise.all([chmod(executable, 0o755), chmod(kernel, 0o755)]);
  const authority = finalAuthority({
    workspace: {
      id: "workspace-1",
      executionWorkspaceId: "execution-workspace-1",
      root: await realpath(workspace),
      realRoot: await realpath(workspace),
    },
    instructions: {
      content: "managed",
      revision: null,
      sourcePath: await realpath(instructions),
      sha256: sha256Text("managed"),
    },
    skills: managedInWorkspace
      ? [
          {
            key: "assigned",
            versionId: null,
            path: await realpath(skillPath),
            sha256: await attestedSkillDigest(await realpath(skillPath)),
          },
        ]
      : [],
    executeDeadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
    controlDeadlineAt: new Date(Date.now() + 120_000).toISOString(),
  });
  const request = launch(authority);
  const db = openDatabase(join(root, "state.sqlite"));
  const repository = new PrimeRunRepository(db);
  repository.admit(request);
  const worker = new BwrapPrimeContainedWorker({
    executable,
    executableSha256: sha256Text(await readFile(executable, "utf8")),
    runtimeRoot,
    runtimeSha256: await attestedPathDigest(runtimeRoot),
    ipcRoot: root,
    privatePaths: [join(root, "state.sqlite")],
    repository,
  });
  async function* broker(input: unknown) {
    if (
      !input ||
      typeof input !== "object" ||
      !("requestId" in input) ||
      !("payload" in input) ||
      !input.payload ||
      typeof input.payload !== "object" ||
      !("method" in input.payload)
    )
      throw new Error("bad fixture broker input");
    if (input.payload.method !== "operation.status")
      throw new Error("fixture does not provide a model");
    yield {
      version: 2,
      requestId: input.requestId,
      sequence: 0,
      kind: "result",
      result: {
        kind: "operation",
        fenced: false,
        provider: "uncertain",
        governedActions: "settled",
        outstandingEffects: 0,
      },
    };
  }
  return {
    root,
    outside,
    workspace,
    runtimeRoot,
    executable,
    request,
    worker,
    db,
    repository,
    broker,
    instructions,
    skillPath,
  };
}

const fixtureScript = `#!/bin/sh
read initialize
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
read new_session
printf '%s' "$new_session" | grep -q '"method":"session/new"' || exit 24
session_id=$(python3 -c 'import json;print(json.load(open("/run/prime/manifest.json"))["session"]["id"])')
printf '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"%s"}}\\n' "$session_id"
read prompt
printf '%s' workspace > "$PWD/workspace-write.txt"
sh -c 'printf %s child > "$1"' sh "$PWD/child-write.txt"
python3 -c 'import pathlib, sys; pathlib.Path(sys.argv[1]).write_text("python")' "$PWD/python-write.txt"
if grep -qE '^[[:space:]]*(eth|en|wl)[^:]*:' /proc/net/dev; then printf '%s' shared > "$PWD/network-state.txt"; else printf '%s' isolated > "$PWD/network-state.txt"; fi
if [ -n "$PAPERCLIP_API_KEY" ]; then printf '%s' leaked > "$PWD/credential-state.txt"; else printf '%s' isolated > "$PWD/credential-state.txt"; fi
if printf '%s' escaped > "$PWD/escape/probe.txt" 2>/dev/null; then printf '%s' escaped > "$PWD/symlink-state.txt"; else printf '%s' blocked > "$PWD/symlink-state.txt"; fi
printf '%s\\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"session_info_update","_meta":{"quiescence":{"status":"settled"}}}}}'
printf '%s\\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","messageId":"native-message-1","content":{"type":"text","text":"Assigned response"}}}}'
printf '%s\\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
`;

describe("Prime bubblewrap containment regression (fixture ACP, not native proof)", () => {
  it("refuses private IPC reachable through the assigned workspace before child launch or broker dispatch", async () => {
    const { db, workspace, executable, runtimeRoot, request, repository, broker } =
      await fixture(fixtureScript);
    const ipcRoot = join(workspace, "private-ipc");
    await mkdir(ipcRoot, { mode: 0o700 });
    const worker = new BwrapPrimeContainedWorker({
      executable,
      executableSha256: await attestedPathDigest(executable),
      runtimeRoot,
      runtimeSha256: await attestedPathDigest(runtimeRoot),
      ipcRoot,
      privatePaths: [join(workspace, "..", "state.sqlite")],
      repository,
    });
    let dispatched = 0;
    await expect(
      (async () => {
        for await (const _ of worker.execute(
          request,
          new AbortController().signal,
          async function* (input) {
            dispatched++;
            yield* broker(input);
          },
        )) {
          /* Admission must refuse before an accepted receipt. */
        }
      })(),
    ).rejects.toThrow();
    expect(dispatched).toBe(0);
    await expect(readFile(join(workspace, "workspace-write.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    db.close();
  });

  it("stops the owned writer at its deadline even when durable stop writes fail, retaining uncertainty", async () => {
    // Real-platform deadline test: fake clocks cannot drive the child namespace's
    // writer and Linux signal/exit delivery together. The guard is teardown only.
    const script = `#!/bin/sh
read initialize
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
read new_session
printf '%s' "$new_session" | grep -q '"method":"session/new"' || exit 24
session_id=$(python3 -c 'import json;print(json.load(open("/run/prime/manifest.json"))["session"]["id"])')
printf '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"%s"}}\\n' "$session_id"
read prompt
while true; do date +%s%N > "$PWD/alive.txt"; sleep 0.05; done
`;
    const { worker, request, repository, broker, db } = await fixture(script, false, 1_000);
    vi.spyOn(repository, "markStopping").mockImplementation(() => {
      throw new Error("owned fixture disk write failure");
    });
    const controller = new AbortController();
    const guard = setTimeout(() => controller.abort(), 3_000);
    const events = [];
    try {
      for await (const event of worker.execute(request, controller.signal, broker))
        events.push(event);
      expect(controller.signal.aborted).toBe(false);
      expect(events.at(-1)).toMatchObject({
        type: "terminal",
        outcome: "uncertain",
        settlement: { worker: "stopped", descendants: "stopped", provider: "uncertain" },
      });
    } finally {
      clearTimeout(guard);
      controller.abort();
      await worker.cancel(request.operationId);
      db.close();
    }
  }, 10_000);

  it("stops its actual owned child before a stalled broker stop is released", async () => {
    // Real Linux child/exit integration: the deadline distinguishes prompt local
    // cancellation from waiting for remote control, without a test sleep.
    const script = `#!/bin/sh
read initialize
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
read new_session
session_id=$(python3 -c 'import json;print(json.load(open("/run/prime/manifest.json"))["session"]["id"])')
printf '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"%s"}}\\n' "$session_id"
read prompt
printf '%s\\n' '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"writer ready"}}}}'
while true; do :; done
`;
    const { worker, request, broker, db } = await fixture(script, false, 1_000);
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    let markStopStarted!: () => void;
    const stopStarted = new Promise<void>((resolve) => { markStopStarted = resolve; });
    let resumeStop!: () => void;
    const releaseStop = new Promise<void>((resolve) => { resumeStop = resolve; });
    const stoppedBroker = async function* (input: unknown) {
      const envelope = input as { requestId: string; payload: { method: string } };
      if (envelope.payload.method !== "operation.stop") {
        yield* broker(input);
        return;
      }
      markStopStarted();
      await releaseStop;
      yield {
        version: 2,
        requestId: envelope.requestId,
        sequence: 0,
        kind: "result",
        result: {
          kind: "operation",
          fenced: true,
          provider: "uncertain",
          governedActions: "settled",
          outstandingEffects: 0,
        },
      };
    };
    const running = (async () => {
      const events = [];
      for await (const event of worker.execute(
        request,
        new AbortController().signal,
        stoppedBroker,
      )) {
        events.push(event);
        if (event.type === "message" && event.content === "writer ready") markReady();
      }
      return events;
    })();
    let cancelling: Promise<unknown> | undefined;
    try {
      await ready;
      cancelling = worker.cancel(request.operationId);
      await stopStarted;
      const events = await running;
      expect(Date.now()).toBeLessThan(Date.parse(request.authority.executeDeadlineAt));
      expect(events.at(-1)).toMatchObject({
        type: "terminal",
        settlement: { worker: "stopped", descendants: "stopped", provider: "uncertain" },
      });
    } finally {
      resumeStop();
      await cancelling;
      await running;
      db.close();
    }
  }, 10_000);

  it("exercises namespace write boundaries with an ACP-shaped shell fixture, without treating it as native settlement", async () => {
    const { db, workspace, outside, request, worker, broker } = await fixture(fixtureScript);
    await symlink(outside, join(workspace, "escape"));
    const events = [];
    for await (const event of worker.execute(request, new AbortController().signal, broker))
      events.push(event);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "accepted", primeSessionId: expect.any(String) }),
        expect.objectContaining({
          type: "message",
          messageId: "native-message-1",
          content: "Assigned response",
        }),
        expect.objectContaining({
          type: "terminal",
          outcome: "uncertain",
          settlement: expect.objectContaining({ provider: "uncertain" }),
        }),
      ]),
    );
    expect(events.filter((event) => event.type === "message")).toHaveLength(1);
    for (const [file, expected] of [
      ["workspace-write.txt", "workspace"],
      ["child-write.txt", "child"],
      ["python-write.txt", "python"],
      ["network-state.txt", "isolated"],
      ["credential-state.txt", "isolated"],
      ["symlink-state.txt", "blocked"],
    ] as const)
      expect(await readFile(join(workspace, file), "utf8")).toBe(expected);
    await expect(readFile(join(outside, "probe.txt"))).rejects.toThrow();
    db.close();
  });

  it("keeps managed instruction and skill source aliases read-only inside the writable workspace", async () => {
    const script = `#!/bin/sh
read initialize
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
read new_session
session_id=$(python3 -c 'import json;print(json.load(open("/run/prime/manifest.json"))["session"]["id"])')
printf '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"%s"}}\\n' "$session_id"
read prompt
if printf changed > "$PWD/managed/instructions.md" 2>/dev/null; then printf allowed > "$PWD/instruction-alias-state.txt"; else printf denied > "$PWD/instruction-alias-state.txt"; fi
if python3 -c 'import pathlib,sys;pathlib.Path(sys.argv[1]).write_text("changed")' "$PWD/managed/skill/SKILL.md" 2>/dev/null; then printf allowed > "$PWD/skill-alias-state.txt"; else printf denied > "$PWD/skill-alias-state.txt"; fi
printf writable > "$PWD/unmanaged.txt"
printf '%s\\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
`;
    const { db, root, repository, request, worker, broker, workspace, instructions, skillPath } =
      await fixture(script, true);
    const mount = await createPrimeIpcMount({ root, request, repository, broker });
    expect(
      JSON.parse(await readFile(join(mount.directory, "manifest.json"), "utf8")),
    ).toMatchObject({ readPaths: expect.arrayContaining([instructions, skillPath]) });
    await mount.close();
    const events = [];
    for await (const event of worker.execute(request, new AbortController().signal, broker))
      events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "terminal", outcome: "uncertain" });
    expect(await readFile(instructions, "utf8")).toBe("managed");
    expect(await readFile(join(skillPath, "SKILL.md"), "utf8")).toBe("assigned skill");
    expect(await readFile(join(workspace, "instruction-alias-state.txt"), "utf8")).toBe("denied");
    expect(await readFile(join(workspace, "skill-alias-state.txt"), "utf8")).toBe("denied");
    expect(await readFile(join(workspace, "unmanaged.txt"), "utf8")).toBe("writable");
    db.close();
  });

  it("rejects changed reviewed executable before creating a native worker", async () => {
    const { db, request, worker, broker, executable } = await fixture(fixtureScript);
    await writeFile(executable, "#!/bin/sh\nexit 1\n");
    await expect(
      worker.execute(request, new AbortController().signal, broker)[Symbol.asyncIterator]().next(),
    ).rejects.toThrow(/executable digest|runtime resource digest/);
    db.close();
  });
});
