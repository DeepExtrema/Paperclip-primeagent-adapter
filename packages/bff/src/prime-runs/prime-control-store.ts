import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface StoredControl {
  purpose: "control";
  operationId: string;
  runId: string;
  authorityDigest: string;
  controlDeadlineAt: string;
  capability: string;
}

/** Protected host-only control capability: encrypted at rest, never part of a run receipt. */
export class PrimeControlStore {
  private readonly key: Buffer;
  constructor(private readonly directory: string, hostBearer: string) {
    if (!hostBearer) throw new Error("Prime control store requires a stable host secret");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory()) throw new Error("Prime control store path must be a directory");
    chmodSync(directory, 0o700);
    this.key = Buffer.from(hkdfSync("sha256", hostBearer, "paperclip-primeagent-control-v3",
      "new-work-original-owner-control-only", 32));
  }

  private path(operationId: string): string {
    return join(this.directory, createHash("sha256").update(operationId).digest("hex") + ".sealed");
  }

  save(value: StoredControl): void {
    if (value.purpose !== "control" || !/^[a-f0-9]{64}$/.test(value.authorityDigest) || !value.capability ||
      Date.parse(value.controlDeadlineAt) <= Date.now()) throw new Error("invalid operation control capability");
    const existing = this.read(value.operationId);
    if (existing) {
      if (existing.runId !== value.runId || existing.authorityDigest !== value.authorityDigest ||
        !timingSafeEqual(createHash("sha256").update(existing.capability).digest(),
          createHash("sha256").update(value.capability).digest()))
        throw new Error("original-owner control capability changed for a reserved operation");
      return;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([value.operationId, value.runId, value.authorityDigest])));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    writeFileSync(this.path(value.operationId), JSON.stringify({
      version: 3, runId: value.runId, authorityDigest: value.authorityDigest,
      iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }), { mode: 0o600, flag: "wx", flush: true });
    const directoryFd = openSync(this.directory, "r");
    try { fsyncSync(directoryFd); }
    finally { closeSync(directoryFd); }
  }

  /** Durable dispatch fence, including stops accepted before local admission. */
  markStopping(operationId: string): void {
    const control = this.read(operationId);
    if (!control) throw new Error("original-owner control is unavailable for stop intent");
    if (this.isStopping(operationId)) return;
    writeFileSync(`${this.path(operationId)}.stopping`,
      JSON.stringify([operationId, control.runId, control.authorityDigest]),
      { mode: 0o600, flag: "wx", flush: true });
    const directoryFd = openSync(this.directory, "r");
    try { fsyncSync(directoryFd); }
    finally { closeSync(directoryFd); }
  }

  isStopping(operationId: string): boolean {
    const path = `${this.path(operationId)}.stopping`;
    if (!existsSync(path)) return false;
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16_384)
      throw new Error("Prime stop intent is not a private bounded file");
    const control = this.read(operationId);
    if (!control || readFileSync(path, "utf8") !== JSON.stringify([operationId, control.runId, control.authorityDigest]))
      throw new Error("Prime stop intent is not bound to original control");
    return true;
  }

  read(operationId: string): StoredControl | null {
    const path = this.path(operationId);
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Prime control record is not a private file");
    const bytes = readFileSync(path);
    if (bytes.length > 16_384) throw new Error("Prime control record length invalid");
    const envelope = JSON.parse(bytes.toString("utf8")) as {
      version: number; runId: string; authorityDigest: string;
      iv: string; tag: string; ciphertext: string;
    };
    if (envelope.version !== 3 || !envelope.runId ||
      !/^[a-f0-9]{64}$/.test(envelope.authorityDigest))
      throw new Error("Prime control envelope binding is invalid");
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("Prime control envelope nonce/tag invalid");
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAAD(Buffer.from(JSON.stringify([operationId, envelope.runId, envelope.authorityDigest])));
    decipher.setAuthTag(tag);
    const result = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final(),
    ]).toString("utf8")) as StoredControl;
    if (result.purpose !== "control" || result.operationId !== operationId || result.runId !== envelope.runId ||
      result.authorityDigest !== envelope.authorityDigest || !result.capability ||
      !Number.isFinite(Date.parse(result.controlDeadlineAt)))
      throw new Error("Prime control record binding is invalid");
    return result;
  }
}
