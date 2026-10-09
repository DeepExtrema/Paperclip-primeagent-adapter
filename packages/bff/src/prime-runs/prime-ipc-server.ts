import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import type { PrimeRunRequest } from "@deepextrema/paperclip-primeagent-adapter"
import type { PrimeRunRepository } from "./prime-run-repository.js";
import { managedWorkspaceAliases } from "./prime-run-port.js";
import { stagePrimeNativeSession, type PrimeNativeSessionStage } from "./prime-native-checkpoint.js";
import {
  PRIME_MAX_FRAME_BYTES, PrimeRestrictedIpcDispatcher,
  type PrimeRestrictedIpcRequest, type PrimeRestrictedIpcResponse,
} from "./prime-restricted-ipc.js";

/** Linux sockaddr_un allows 107 pathname bytes plus its terminating NUL. */
export function validatedPrimeIpcRoot(inputRoot: string): string {
  const root = resolve(inputRoot);
  if (Buffer.byteLength(join(root, "prime-ipc-XXXXXX", "ipc.sock")) > 107)
    throw new Error("Prime IPC root exceeds the 107-byte Unix socket path limit including its operation suffix");
  return root;
}

export interface PrimeIpcMount {
  directory: string;
  dispatcher: PrimeRestrictedIpcDispatcher;
  session: PrimeNativeSessionStage;
  close(): Promise<void>;
}

/** One operation, one private host socket; only a read-only directory enters its network namespace. */
export async function createPrimeIpcMount(input: {
  root: string;
  request: PrimeRunRequest;
  repository: PrimeRunRepository;
  broker(request: unknown, purpose: "execute" | "control"): AsyncIterable<unknown>;
  observeFrame?: (request: PrimeRestrictedIpcRequest, frame: PrimeRestrictedIpcResponse) => void;
}): Promise<PrimeIpcMount> {
  const directory = await mkdtemp(join(validatedPrimeIpcRoot(input.root), "prime-ipc-"));
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  try {
    const { request } = input;
    const session = await stagePrimeNativeSession({
      request, repository: input.repository, operationDirectory: directory, root: input.root,
    });
    const authority = request.authority;
    const connections = new Map<string, Array<Omit<typeof authority.mcp.tools[number], "connectionId">>>();
    for (const { connectionId, ...tool } of authority.mcp.tools) {
      const assigned = connections.get(connectionId) ?? [];
      assigned.push(tool);
      connections.set(connectionId, assigned);
    }
    const manifest = {
      version: 2,
      authorityDigest: request.authorityDigest,
      operationId: request.operationId,
      turnId: request.turnId,
      model: `openai-codex/${authority.selection.model}`,
      instruction: authority.instructions.content,
      prompt: authority.prompt,
      workspace: authority.workspace.realRoot,
      session: { id: session.id, directory: session.directory, resume: session.resume },
      harness: authority.harness,
      readPaths: [
        authority.workspace.realRoot,
        "/run/prime/session",
        "/run/prime/session-artifacts",
        "/opt/paperclip/managed-instructions.md",
        "/opt/paperclip/runtime",
        ...authority.skills.map((_, index) => `/opt/paperclip/skills/${index}`),
        ...managedWorkspaceAliases(request, directory).map(({ original }) => original),
      ],
      deadlineAt: authority.executeDeadlineAt,
      mcp: [...connections.entries()].map(([connectionId, tools]) => ({ connectionId, tools })),
      localTools: authority.localTools,
    };
    const manifestJson = JSON.stringify(manifest);
    if (Buffer.byteLength(manifestJson) > PRIME_MAX_FRAME_BYTES)
      throw new Error("final Paperclip manifest exceeds native managed runtime bound");
    await writeFile(join(directory, "manifest.json"), manifestJson, { mode: 0o400, flag: "wx" });
    const dispatcher = new PrimeRestrictedIpcDispatcher({ ...authority, authorityDigest: request.authorityDigest },
      { broker: input.broker }, input.repository, undefined, input.observeFrame);
    server = createServer({ allowHalfOpen: true }, (socket) => {
      if (sockets.size >= 64) { socket.destroy(); return; }
      sockets.add(socket);
      const chunks: Buffer[] = [];
      let received = 0;
      let accepted = false;
      socket.on("close", () => { sockets.delete(socket); });
      socket.on("error", () => { socket.destroy(); });
      socket.on("end", () => { if (!accepted) socket.destroy(); });
      socket.on("data", (chunk: Buffer) => {
        if (accepted || received + chunk.length > PRIME_MAX_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        received += chunk.length;
        chunks.push(chunk);
        if (!chunk.includes(10)) return;
        const buffered = Buffer.concat(chunks, received);
        const newline = buffered.indexOf(10);
        if (newline < 0 || buffered.subarray(newline + 1).toString("utf8").trim()) {
          socket.destroy();
          return;
        }
        accepted = true;
        socket.pause();
        void (async () => {
          try {
            await dispatcher.dispatch(JSON.parse(new TextDecoder("utf-8", { fatal: true })
              .decode(buffered.subarray(0, newline))) as unknown, async (frame) => {
              if (socket.destroyed) return;
              const encoded = `${JSON.stringify(frame)}\n`;
              if (Buffer.byteLength(encoded) > PRIME_MAX_FRAME_BYTES)
                throw new Error("managed broker frame exceeded IPC limit");
              if (socket.write(encoded)) return;
              await new Promise<void>((resolve) => {
                const cleanup = () => {
                  socket.off("drain", onDrain);
                  socket.off("close", onClose);
                };
                const onDrain = () => { cleanup(); resolve(); };
                const onClose = () => { cleanup(); resolve(); };
                socket.once("drain", onDrain);
                socket.once("close", onClose);
              });
            });
          } catch {
            // Malformed/unauthorized frames never reach Paperclip. No worker-selected error text.
            socket.destroy();
            return;
          }
          if (!socket.destroyed) socket.end();
        })();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(join(directory, "ipc.sock"), () => {
        server!.off("error", reject);
        resolve();
      });
    });
    await chmod(join(directory, "ipc.sock"), 0o600);
    return {
      directory, dispatcher, session,
      async close() {
        dispatcher.fenceExecution();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server?.close();
    for (const socket of sockets) socket.destroy();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
