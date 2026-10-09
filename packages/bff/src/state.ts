import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { validatedPrimeIpcRoot } from "./prime-runs/prime-ipc-server.js";

export interface OwnedPrimeState {
  root: string;
  secret: Buffer;
  release(): void;
}

function privateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Prime state file must be private, regular, and owned by this process");
}

function syncDirectory(root: string): void {
  const fd = openSync(root, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** An unclean exit deliberately leaves the lock: verify the old process is gone
 * and decide how to quarantine its work before an operator removes the lock. */
export function ownPrimeState(root: string): OwnedPrimeState {
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error("Prime state root must be an absolute normalized path");
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error("Prime state root cannot be a symlink");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root) throw new Error("Prime state root must be canonical");
  const stat = lstatSync(root);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Prime state root must be private and owned by this process");
  validatedPrimeIpcRoot(root);
  const lockPath = join(root, "prime-owner.lock");
  let fd: number;
  try { fd = openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Prime state is already owned or an unclean exit is quarantined; verify the prior process and writer before manually clearing its owner lock");
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flush: true });
    syncDirectory(root);
    const secretPath = join(root, "control-secret.key");
    if (!existsSync(secretPath)) {
      try { writeFileSync(secretPath, randomBytes(32), { flag: "wx", mode: 0o600, flush: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      syncDirectory(root);
    }
    privateFile(secretPath);
    const secret = readFileSync(secretPath);
    if (secret.length !== 32) throw new Error("Prime control secret must be exactly 32 bytes");
    let released = false;
    return { root, secret, release() {
      if (released) return;
      released = true;
      privateFile(lockPath);
      unlinkSync(lockPath);
      syncDirectory(root);
      closeSync(fd);
    } };
  } catch (error) {
    closeSync(fd);
    unlinkSync(lockPath);
    syncDirectory(root);
    throw error;
  }
}
