import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PrimeRestrictedIpcDispatcher,
  type PrimeRestrictedIpcRequest,
} from "../src/prime-runs/prime-restricted-ipc.js";
import { PrimeRunRepository } from "../src/prime-runs/prime-run-repository.js";
import { openDatabase } from "../src/store/database.js";
import { AUTHORITY_DIGEST, finalAuthority, launch } from "./prime-test-authority.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function frame(
  requestId: string,
  payload: PrimeRestrictedIpcRequest["payload"],
): PrimeRestrictedIpcRequest {
  return {
    version: 2,
    authorityDigest: AUTHORITY_DIGEST,
    operationId: "run-1",
    requestId,
    payload,
  };
}
function reply(requestId: string, sequence = 0) {
  return {
    version: 2,
    requestId,
    sequence,
    kind: "result" as const,
    result: { kind: "provider", providerRequestId: "resp-1", state: "completed", usage: null },
  };
}

async function disk() {
  const root = await mkdtemp(join(tmpdir(), "prime-ipc-durable-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  const db = openDatabase(path);
  const store = new PrimeRunRepository(db);
  store.admit(launch());
  return { path, db, store };
}

const now = () => Date.parse("2029-12-31T12:00:00.000Z");
const nativeRequest = {
  model: "gpt-6.1-sol",
  store: false,
  stream: true,
  instructions: "managed",
  input: [],
  text: { verbosity: "low" },
  include: ["reasoning.encrypted_content"],
  reasoning: { effort: "high", summary: "auto" },
  service_tier: "default",
};

describe("operation-scoped restricted broker IPC", () => {
  it("streams authentic ordered provider receipts and never redispatches after disk reopen", async () => {
    const { path, db, store } = await disk();
    let dispatched = 0;
    const broker = {
      async *broker(request: PrimeRestrictedIpcRequest) {
        dispatched++;
        yield {
          version: 2,
          requestId: request.requestId,
          sequence: 2,
          kind: "provider_event",
          event: { type: "response.created", response: { id: "resp-1", status: "in_progress" } },
        };
        yield {
          version: 2,
          requestId: request.requestId,
          sequence: 3,
          kind: "provider_event",
          event: { type: "response.completed", response: { id: "resp-1", status: "completed" } },
        };
        yield reply(request.requestId, 4);
      },
    };
    const input = frame("call-1", {
      method: "provider.stream",
      turnId: "run-1-turn",
      request: nativeRequest,
    });
    const first = await new PrimeRestrictedIpcDispatcher(
      { ...finalAuthority(), authorityDigest: AUTHORITY_DIGEST },
      broker,
      store,
      now,
    ).dispatch(input);
    expect(first.at(-1)).toMatchObject({ result: { state: "completed" } });
    db.close();
    const reopened = openDatabase(path);
    const replay = new PrimeRestrictedIpcDispatcher(
      { ...finalAuthority(), authorityDigest: AUTHORITY_DIGEST },
      broker,
      new PrimeRunRepository(reopened),
      now,
    );
    expect(await replay.dispatch(input)).toEqual(first);
    expect(dispatched).toBe(1);
    await expect(
      replay.dispatch({
        ...input,
        payload: {
          ...input.payload,
          request: { ...nativeRequest, input: [{ role: "user", content: "other" }] },
        },
      }),
    ).rejects.toThrow();
    reopened.close();
  });

  it("streams and durably replays more than 8192 ordered provider frames including a >1 MiB frame", async () => {
    const { db, store } = await disk();
    let observed = 0;
    const ipc = new PrimeRestrictedIpcDispatcher(
      { ...finalAuthority(), authorityDigest: AUTHORITY_DIGEST },
      {
        async *broker(request) {
          yield { version: 2, requestId: request.requestId, sequence: 0,
            kind: "provider_event", event: {
              type: "response.created", response: { id: "resp-1", status: "in_progress" },
            } };
          for (let sequence = 1; sequence <= 8200; sequence++) {
            yield { version: 2, requestId: request.requestId, sequence,
              kind: "provider_event", event: {
                type: "response.output_text.delta",
                delta: sequence === 1 ? "x".repeat(1_050_000) : "x",
              } };
          }
          yield { version: 2, requestId: request.requestId, sequence: 8201,
            kind: "provider_event", event: {
              type: "response.completed", response: { id: "resp-1", status: "completed" },
            } };
          yield reply(request.requestId, 8202);
        },
      }, store, now,
    );
    const input = frame("long-stream", {
      method: "provider.stream", turnId: "run-1-turn", request: nativeRequest,
    });
    const receipts = await ipc.dispatch(input, async () => { observed++; });
    expect(receipts).toHaveLength(8203);
    expect(observed).toBe(8203);
    expect(receipts.at(-1)).toMatchObject({ result: { state: "completed" } });
    expect(await ipc.dispatch(input)).toEqual(receipts);
    db.close();
  });

  it("accepts exact original-owner nonacceptance without forging an SSE terminal", async () => {
    const { db, store } = await disk();
    const ipc = new PrimeRestrictedIpcDispatcher(
      { ...finalAuthority(), authorityDigest: AUTHORITY_DIGEST },
      {
        async *broker(request) {
          yield { version: 2, requestId: request.requestId, sequence: 0, kind: "result",
            result: { kind: "provider", providerRequestId: null, state: "failed", usage: null } };
        },
      }, store, now,
    );
    ipc.enableControlCapability();
    const initial = await ipc.dispatch(frame("rejected", {
      method: "provider.stream", turnId: "run-1-turn", request: nativeRequest,
    }));
    expect(initial).toMatchObject([{ result: {
      kind: "provider", providerRequestId: null, state: "failed" } }]);
    expect(ipc.hasTerminalProviderReceipt).toBe(true);
    const ownerStatus = await ipc.dispatch(frame("status-rejected", {
      method: "provider.status", targetRequestId: "rejected",
    }));
    expect(ownerStatus).toMatchObject([{ result: { providerRequestId: null, state: "failed" } }]);
    expect(ipc.usage).toBeNull();
    db.close();
  });

  it("preserves truncated possibly accepted stream as uncertainty and refuses replacement", async () => {
    const { path, db, store } = await disk();
    let dispatched = 0;
    const broker = {
      async *broker(request: PrimeRestrictedIpcRequest) {
        dispatched++;
        yield {
          version: 2,
          requestId: request.requestId,
          sequence: 0,
          kind: "provider_event",
          event: { type: "response.created", response: { id: "resp-1" } },
        };
      },
    };
    const input = frame("call-1", {
      method: "provider.stream",
      turnId: "run-1-turn",
      request: nativeRequest,
    });
    const first = await new PrimeRestrictedIpcDispatcher(
      { ...finalAuthority(), authorityDigest: AUTHORITY_DIGEST },
      broker,
      store,
      now,
    ).dispatch(input);
    expect(first.at(-1)).toMatchObject({
      kind: "error",
      error: { code: "broker_outcome_uncertain" },
    });
    db.close();
    const reopened = openDatabase(path);
    const restart = new PrimeRestrictedIpcDispatcher(
      { ...finalAuthority(), authorityDigest: AUTHORITY_DIGEST },
      broker,
      new PrimeRunRepository(reopened),
      now,
    );
    expect(await restart.dispatch(input)).toEqual(first.slice(-1));
    expect(dispatched).toBe(1);
    reopened.close();
  });

  it("rejects cross-run targets, forbidden tool policies, raw URLs and authority tampering before broker dispatch", async () => {
    const { db, store } = await disk();
    let dispatched = 0;
    const broker = {
      async *broker(request: PrimeRestrictedIpcRequest) {
        dispatched++;
        yield reply(request.requestId);
      },
    };
    const ipc = new PrimeRestrictedIpcDispatcher(
      { ...finalAuthority(), authorityDigest: AUTHORITY_DIGEST },
      broker,
      store,
      now,
    );
    ipc.enableControlCapability();
    await expect(
      ipc.dispatch(
        frame("lookup", { method: "provider.status", targetRequestId: "other-run-request" }),
      ),
    ).rejects.toThrow();
    await expect(
      ipc.dispatch(
        frame("denied", {
          method: "mcp.tools.call",
          connectionId: "connection-1",
          tool: "denied",
          arguments: {},
        }),
      ),
    ).rejects.toThrow();
    await expect(
      ipc.dispatch(
        frame("url", {
          method: "provider.stream",
          turnId: "run-1-turn",
          request: { ...nativeRequest, url: "http://localhost" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      ipc.dispatch({
        ...frame("wrong-digest", { method: "provider.catalog" }),
        authorityDigest: "0".repeat(64),
      }),
    ).rejects.toThrow();
    expect(dispatched).toBe(0);
    db.close();
  });

  it("accepts only correlated upstream terminal replay on owner-control provider status", async () => {
    const { db, store } = await disk();
    store.reserve("run-1", "original-stream", "1".repeat(64));
    const purposes: string[] = [];
    const ipc = new PrimeRestrictedIpcDispatcher(
      { ...finalAuthority(), authorityDigest: AUTHORITY_DIGEST },
      {
        async *broker(request, purpose) {
          purposes.push(purpose);
          yield {
            version: 2,
            requestId: request.requestId,
            sequence: 2,
            kind: "provider_event",
            event: {
              type: "response.completed",
              response: { id: "provider-1", status: "completed" },
            },
          };
          yield {
            version: 2,
            requestId: request.requestId,
            sequence: 3,
            kind: "result",
            result: {
              kind: "provider",
              providerRequestId: "provider-1",
              state: "completed",
              usage: {
                input_tokens: 13,
                output_tokens: 7,
                input_tokens_details: { cached_tokens: 4 },
              },
            },
          };
        },
      },
      store,
      now,
    );
    ipc.enableControlCapability();
    const observed = await ipc.dispatch(
      frame("status-provider", {
        method: "provider.status",
        targetRequestId: "original-stream",
      }),
    );
    expect(observed.map((item) => item.kind)).toEqual(["provider_event", "result"]);
    expect(ipc.hasTerminalProviderReceipt).toBe(true);
    expect(ipc.usage).toEqual({ inputTokens: 13, outputTokens: 7, cachedInputTokens: 4 });
    expect(purposes).toEqual(["control"]);
    db.close();
  });

  it("aggregates distinct provider calls once, including repeated original-owner status replay", async () => {
    const { db, store } = await disk();
    const usageByRequest: Record<
      string,
      {
        input_tokens: number;
        output_tokens: number;
        input_tokens_details: { cached_tokens: number };
      }
    > = {
      "model-first": {
        input_tokens: 13,
        output_tokens: 7,
        input_tokens_details: { cached_tokens: 4 },
      },
      "model-second": {
        input_tokens: 5,
        output_tokens: 3,
        input_tokens_details: { cached_tokens: 2 },
      },
    };
    let providerDispatches = 0;
    const ipc = new PrimeRestrictedIpcDispatcher(
      { ...finalAuthority(), authorityDigest: AUTHORITY_DIGEST },
      {
        async *broker(request) {
          const original =
            "targetRequestId" in request.payload
              ? request.payload.targetRequestId
              : request.requestId;
          const response = { id: `response-${original}`, status: "completed" };
          let sequence = 0;
          if (request.payload.method === "provider.stream") {
            providerDispatches++;
            yield {
              version: 2,
              requestId: request.requestId,
              sequence: sequence++,
              kind: "provider_event",
              event: { type: "response.created", response: { ...response, status: "in_progress" } },
            };
          }
          yield {
            version: 2,
            requestId: request.requestId,
            sequence: sequence++,
            kind: "provider_event",
            event: { type: "response.completed", response },
          };
          yield {
            version: 2,
            requestId: request.requestId,
            sequence,
            kind: "result",
            result: {
              kind: "provider",
              providerRequestId: response.id,
              state: "completed",
              usage: usageByRequest[original],
            },
          };
        },
      },
      store,
      now,
    );
    ipc.enableControlCapability();
    const first = frame("model-first", {
      method: "provider.stream",
      turnId: "run-1-turn",
      request: nativeRequest,
    });
    await ipc.dispatch(first);
    await ipc.dispatch(
      frame("model-second", {
        method: "provider.stream",
        turnId: "run-1-turn",
        request: nativeRequest,
      }),
    );
    expect(ipc.usage).toEqual({ inputTokens: 18, outputTokens: 10, cachedInputTokens: 6 });
    await ipc.dispatch(first);
    await ipc.dispatch(
      frame("status-first", { method: "provider.status", targetRequestId: "model-first" }),
    );
    await ipc.dispatch(
      frame("status-first-again", { method: "provider.status", targetRequestId: "model-first" }),
    );
    expect(ipc.usage).toEqual({ inputTokens: 18, outputTokens: 10, cachedInputTokens: 6 });
    expect(providerDispatches).toBe(2);
    db.close();
  });

  it.each([
    ["response.completed", "in_progress", "provider-1"],
    ["response.failed", "completed", "provider-1"],
    ["response.incomplete", "incomplete", "provider-1"],
    ["response.done", "cancelled", "provider-1"],
    ["response.completed", "completed", "other-provider"],
  ])(
    "retains uncertainty for inconsistent terminal %s/%s/%s without redispatch",
    async (type, status, id) => {
      const { path, db, store } = await disk();
      store.reserve("run-1", "original-stream", "1".repeat(64));
      let dispatched = 0;
      const broker = {
        async *broker(request: PrimeRestrictedIpcRequest) {
          dispatched++;
          yield {
            version: 2,
            requestId: request.requestId,
            sequence: 0,
            kind: "provider_event",
            event: { type, response: { id, status } },
          };
          yield {
            version: 2,
            requestId: request.requestId,
            sequence: 1,
            kind: "result",
            result: {
              kind: "provider",
              providerRequestId: "provider-1",
              state: "completed",
              usage: null,
            },
          };
        },
      };
      const ipc = new PrimeRestrictedIpcDispatcher(
        { ...finalAuthority(), authorityDigest: AUTHORITY_DIGEST },
        broker,
        store,
        now,
      );
      ipc.enableControlCapability();
      const input = frame("inconsistent-terminal", {
        method: "provider.status",
        targetRequestId: "original-stream",
      });
      const observed = await ipc.dispatch(input);
      expect(observed.at(-1)).toMatchObject({
        kind: "error",
        error: { code: "broker_outcome_uncertain" },
      });
      expect(ipc.hasTerminalProviderReceipt).toBe(false);
      db.close();
      const reopened = openDatabase(path);
      const restart = new PrimeRestrictedIpcDispatcher(
        { ...finalAuthority(), authorityDigest: AUTHORITY_DIGEST },
        broker,
        new PrimeRunRepository(reopened),
        now,
      );
      restart.enableControlCapability();
      expect(await restart.dispatch(input)).toEqual(observed);
      expect(restart.hasTerminalProviderReceipt).toBe(false);
      expect(dispatched).toBe(1);
      reopened.close();
    },
  );

  it("uses original-owner control for read-only status even before execute expires", async () => {
    const { db, store } = await disk();
    const purposes: string[] = [];
    const ipc = new PrimeRestrictedIpcDispatcher(
      { ...finalAuthority(), authorityDigest: AUTHORITY_DIGEST },
      {
        async *broker(request, purpose) {
          purposes.push(purpose);
          yield {
            version: 2,
            requestId: request.requestId,
            sequence: 0,
            kind: "result",
            result: {
              kind: "operation",
              fenced: false,
              provider: "uncertain",
              governedActions: "uncertain",
              outstandingEffects: 1,
            },
          };
        },
      },
      store,
      now,
    );
    ipc.enableControlCapability();
    await ipc.dispatch(frame("status-during-execute", { method: "operation.status" }));
    ipc.fenceExecution();
    await ipc.dispatch(frame("status-after-fence", { method: "operation.status" }));
    expect(purposes).toEqual(["control", "control"]);
    db.close();
  });

  it("fences new effects after execute expiry while original-owner read and stop remain available", async () => {
    const { db, store } = await disk();
    const purposes: string[] = [];
    const broker = {
      async *broker(request: PrimeRestrictedIpcRequest, purpose: string) {
        purposes.push(purpose);
        yield {
          version: 2,
          requestId: request.requestId,
          sequence: 0,
          kind: "result",
          result: {
            kind: "operation",
            fenced: true,
            provider: "uncertain",
            governedActions: "uncertain",
            outstandingEffects: 1,
          },
        };
      },
    };
    const ipc = new PrimeRestrictedIpcDispatcher(
      { ...finalAuthority(), authorityDigest: AUTHORITY_DIGEST },
      broker,
      store,
      () => Date.parse("2030-01-01T13:00:00.000Z"),
    );
    ipc.enableControlCapability();
    ipc.fenceExecution();
    await expect(
      ipc.dispatch(
        frame("new", { method: "provider.stream", turnId: "run-1-turn", request: nativeRequest }),
      ),
    ).rejects.toThrow();
    expect(
      (await ipc.dispatch(frame("status", { method: "operation.status" }))).at(-1),
    ).toMatchObject({ result: { kind: "operation", provider: "uncertain" } });
    await ipc.dispatch(frame("stop", { method: "operation.stop" }));
    expect(purposes).toEqual(["control", "control"]);
    db.close();
  });
  it("accepts only credential-free Paperclip paths and records an own-issue finish intent", async () => {
    const { db, store } = await disk();
    const ipc = new PrimeRestrictedIpcDispatcher(
      { ...finalAuthority(), authorityDigest: AUTHORITY_DIGEST },
      {
        async *broker(request) {
          yield { version: 2, requestId: request.requestId, sequence: 0, kind: "result",
            result: request.payload.method === "paperclip.request"
              ? { kind: "paperclip", requestId: request.requestId, status: 200,
                  body: { id: "issue-1" } }
              : { kind: "finalization", intentId: "intent-1", issueId: "issue-1",
                  status: "in_review", summary: "Ready", state: "recorded" } };
        },
      },
      store,
      now,
    );
    await expect(ipc.dispatch(frame("invalid-url", { method: "paperclip.request",
      httpMethod: "GET", path: "https://elsewhere.invalid/api/issues/issue-1" })))
      .rejects.toThrow();
    const read = await ipc.dispatch(frame("read-issue", { method: "paperclip.request",
      httpMethod: "GET", path: "/api/issues/issue-1" }));
    expect(read.at(-1)).toMatchObject({ result: { kind: "paperclip", status: 200 } });
    const finish = await ipc.dispatch(frame("finish", { method: "paperclip.finish",
      status: "in_review", summary: "Ready" }));
    expect(finish.at(-1)).toMatchObject({ result: { kind: "finalization",
      intentId: "intent-1", state: "recorded" } });
    expect(ipc.finalization).toEqual({ intentId: "intent-1", issueId: "issue-1",
      status: "in_review", summary: "Ready" });
    db.close();
  });

});
