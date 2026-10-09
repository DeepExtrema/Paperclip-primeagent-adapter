import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pins = JSON.parse(readFileSync(join(root, "upstream/sources.json"), "utf8"));
const outputRoot = join(root, ".upstream");
mkdirSync(outputRoot, { recursive: true });
const batch = mkdtempSync(join(outputRoot, "pinned-"));
const sources = {};
for (const [name, { url, revision, patch }] of Object.entries(pins)) {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+\.git$/.test(url) ||
    !/^[a-f0-9]{40}$/.test(revision) || !/^upstream\/patches\/[a-z-]+\.patch$/.test(patch))
    throw new Error(`Invalid pinned upstream source ${name}`);
  const patchPath = join(root, patch);
  if (!existsSync(patchPath) || !statSync(patchPath).isFile() || statSync(patchPath).size === 0)
    throw new Error(`Required reviewed upstream patch is absent or empty: ${patch}`);
  const target = join(batch, name);
  execFileSync("git", ["clone", "--no-checkout", "--filter=blob:none", url, target], { stdio: "inherit" });
  execFileSync("git", ["checkout", "--detach", revision], { cwd: target, stdio: "inherit" });
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" }).trim();
  if (actual !== revision) throw new Error(`Upstream ${name} did not resolve to its pinned revision`);
  execFileSync("git", ["apply", "--check", patchPath], { cwd: target, stdio: "inherit" });
  execFileSync("git", ["apply", "--binary", patchPath], { cwd: target, stdio: "inherit" });
  sources[name] = { path: target, revision, patch };
}
writeFileSync(join(batch, "sources.json"), `${JSON.stringify(sources, null, 2)}\n`);
console.log(join(batch, "sources.json"));
