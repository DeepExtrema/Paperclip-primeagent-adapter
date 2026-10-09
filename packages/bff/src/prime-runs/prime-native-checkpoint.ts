import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { PrimeRunRequest } from "@deepextrema/paperclip-primeagent-adapter"
import { settlementProvesRelease } from "@deepextrema/paperclip-primeagent-adapter"
import type { PrimeRunRepository } from "./prime-run-repository.js";

const MAX_CHECKPOINT_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 2048;
const HEX = /^[a-f0-9]{64}$/;

async function digestTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  let count = 0;
  let total = 0;
  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error("native checkpoint contains a symlink");
      if (metadata.isDirectory()) {
        hash.update(`d\0${name}\0`);
        await visit(path);
      } else if (metadata.isFile()) {
        count += 1;
        total += metadata.size;
        if (count > MAX_FILES || total > MAX_CHECKPOINT_BYTES)
          throw new Error("native checkpoint exceeds its assigned storage bound");
        hash.update(`f\0${name}\0`);
        hash.update(await readFile(path));
      } else throw new Error("native checkpoint contains a special file");
    }
  }
  await visit(root);
  return hash.digest("hex");
}

async function flushTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = join(root, entry.name);
    if (entry.isDirectory()) await flushTree(child);
    else {
      const file = await open(child, "r");
      try { await file.sync(); } finally { await file.close(); }
    }
  }
  const directory = await open(root, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function sealTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = join(root, entry.name);
    if (entry.isDirectory()) await sealTree(child);
    else await chmod(child, 0o400);
  }
  await chmod(root, 0o500);
}

async function makePrivateStageWritable(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = join(root, entry.name);
    if (entry.isDirectory()) await makePrivateStageWritable(child);
    else await chmod(child, 0o600);
  }
  await chmod(root, 0o700);
}

function checkpointId(request: PrimeRunRequest, receiptId: string): string {
  return createHash("sha256").update(JSON.stringify([
    request.authority.session.namespace, request.operationId, receiptId,
  ])).digest("hex");
}

export interface PrimeNativeSessionStage {
  id: string;
  directory: string;
  resume: boolean;
  commit(receiptId: string): Promise<{ checkpoint: string; checkpointDigest: string }>;
}

/** Only BFF-owned, settled, immutable checkpoints can become writable per-operation copies. */
export async function stagePrimeNativeSession(input: {
  request: PrimeRunRequest; repository: PrimeRunRepository; operationDirectory: string; root: string;
}): Promise<PrimeNativeSessionStage> {
  const { request, repository, operationDirectory } = input;
  const storeRoot = join(resolve(input.root), "prime-native-checkpoints");
  const directory = join(operationDirectory, "session");
  const artifactDirectory = join(operationDirectory, "session-artifacts");
  await mkdir(storeRoot, { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  await mkdir(artifactDirectory, { mode: 0o700 });
  const previous = request.previousSession;
  const id = previous?.primeSessionId ?? randomUUID();
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(id) || id.includes(".."))
    throw new Error("native session ID is not a safe filename");
  if (previous !== null) {
    if (previous.checkpoint === null || previous.checkpointDigest === null ||
      !HEX.test(previous.checkpoint) || !HEX.test(previous.checkpointDigest) ||
      previous.checkpoint !== checkpointId({ ...request, operationId: previous.runId }, previous.lastReceiptId))
      throw new Error("previous native checkpoint ID is not bound to its committed receipt");
    const [terminal] = repository.replay(previous.runId).filter((event) => event.type === "terminal");
    if (!terminal || terminal.type !== "terminal" || terminal.outcome !== "completed" ||
      !settlementProvesRelease(terminal.settlement) || terminal.receiptId !== previous.lastReceiptId ||
      terminal.session.checkpoint !== previous.checkpoint ||
      terminal.session.checkpointDigest !== previous.checkpointDigest ||
      terminal.session.primeSessionId !== id ||
      terminal.session.namespace !== request.authority.session.namespace ||
      terminal.session.companyId !== request.identity.companyId ||
      terminal.session.agentId !== request.identity.agentId ||
      terminal.session.issueId !== request.identity.issueId ||
      terminal.session.workspaceRoot !== request.workspace.realRoot ||
      terminal.session.model !== request.model.id ||
      terminal.session.connectionId !== request.authority.selection.connectionId)
      throw new Error("previous native checkpoint lacks a settled original BFF receipt");
    const committed = join(storeRoot, previous.checkpoint);
    if (!(await lstat(committed)).isDirectory() ||
      await digestTree(committed) !== previous.checkpointDigest)
      throw new Error("committed native checkpoint digest changed");
    const metadata = JSON.parse(await readFile(join(committed, "metadata.json"), "utf8")) as Record<string, unknown>;
    if (metadata.namespace !== request.authority.session.namespace ||
      metadata.runId !== previous.runId || metadata.receiptId !== previous.lastReceiptId ||
      metadata.primeSessionId !== id || metadata.workspaceRoot !== request.workspace.realRoot ||
      metadata.connectionId !== request.authority.selection.connectionId ||
      metadata.model !== request.model.id)
      throw new Error("committed native checkpoint scope changed");
    await cp(join(committed, "session"), directory, { recursive: true, force: false, errorOnExist: false });
    await cp(join(committed, "session-artifacts"), artifactDirectory, { recursive: true, force: false, errorOnExist: false });
    await makePrivateStageWritable(directory);
    await makePrivateStageWritable(artifactDirectory);
    if (!(await stat(join(directory, `${id}.jsonl`))).isFile())
      throw new Error("native session transcript is missing from committed checkpoint");
  }
  return {
    id, directory: "/run/prime/session", resume: previous !== null,
    async commit(receiptId) {
      const checkpoint = checkpointId(request, receiptId);
      const temporary = join(storeRoot, `.staging-${randomUUID()}`);
      const committed = join(storeRoot, checkpoint);
      await mkdir(temporary, { mode: 0o700 });
      try {
        await cp(directory, join(temporary, "session"), { recursive: true, errorOnExist: true });
        await cp(artifactDirectory, join(temporary, "session-artifacts"), { recursive: true, errorOnExist: true });
        if (!(await stat(join(temporary, "session", `${id}.jsonl`))).isFile())
          throw new Error("Prime did not persist its native session transcript");
        await writeFile(join(temporary, "metadata.json"), JSON.stringify({
          namespace: request.authority.session.namespace,
          runId: request.identity.runId, receiptId, primeSessionId: id,
          workspaceRoot: request.workspace.realRoot,
          connectionId: request.authority.selection.connectionId, model: request.model.id,
        }), { mode: 0o400, flag: "wx" });
        const checkpointDigest = await digestTree(temporary);
        await flushTree(temporary);
        await sealTree(temporary);
        await flushTree(temporary);
        await rename(temporary, committed);
        const parent = await open(storeRoot, "r");
        try { await parent.sync(); } finally { await parent.close(); }
        return { checkpoint, checkpointDigest };
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
    },
  };
}
