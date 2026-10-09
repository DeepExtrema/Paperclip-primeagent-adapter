import { existsSync, readFileSync } from "node:fs";

function validateLock(file, required) {
  const lock = new URL(`../upstream/${file}`, import.meta.url);
  if (!existsSync(lock)) throw new Error(`Required upstream/${file} is missing`);
  const text = readFileSync(lock, "utf8");
  if (/file:\/\/|git\+|--(?:extra-)?index-url|(?:^|\s)\/(?:home|Users)\//m.test(text))
    throw new Error(`${file} cannot reference mutable indexes, local paths or source checkouts`);
  const requirements = new Map();
  const matches = [...text.matchAll(/^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+!-]+)/gm)];
  for (const [index, match] of matches.entries()) {
    const section = text.slice(match.index, matches[index + 1]?.index ?? text.length);
    const name = match[1].toLowerCase().replaceAll("_", "-");
    if (requirements.has(name) || !/--hash=sha256:[a-f0-9]{64}/.test(section))
      throw new Error(`${file}: ${name} must have a unique exact version and SHA-256 hash`);
    requirements.set(name, match[2]);
  }
  for (const name of required) {
    if (!requirements.has(name)) throw new Error(`${file} lacks ${name}`);
  }
  return requirements.size;
}

const kernel = validateLock("python-requirements.lock", [
  "requests", "httpx", "pyyaml", "tomli", "python-dotenv", "pandas", "numpy",
  "scipy", "beautifulsoup4", "lxml", "pydantic", "tyro", "dill", "mcp", "pip",
]);
if (kernel < 32) throw new Error("Full frozen Prime kernel lock is missing core RLM dependencies");
const builder = validateLock("python-build-requirements.lock", ["hatchling"]);
console.log(`Validated ${kernel} kernel and ${builder} wheel-builder exact hash-pinned requirements`);
