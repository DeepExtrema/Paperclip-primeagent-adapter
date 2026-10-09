import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePrefixAliases, sanitizeKernel } from "./kernel-assets.mjs";

function options(args) {
  if (args.length !== 12) throw new Error("Usage: build-native.mjs --sources ABS_SOURCES_JSON --python-prefix ABS_CPYTHON_3.14.7_PREFIX --output ABS_NEW_RUNTIME_ROOT --bun ABS_BUN_1.4.0 --uv ABS_UV_BINARY --uv-version EXACT_VERSION");
  const opts = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
  for (const key of ["--sources", "--python-prefix", "--output", "--bun", "--uv", "--uv-version"])
    if (!opts[key]) throw new Error(`Missing ${key}`);
  for (const key of ["--sources", "--python-prefix", "--output", "--bun", "--uv"])
    if (!isAbsolute(opts[key]) || resolve(opts[key]) !== opts[key]) throw new Error(`${key} must be an absolute normalized path`);
  return opts;
}

const opts = options(process.argv.slice(2));
if (process.platform !== "linux" || process.arch !== "x64" || process.versions.node !== "24.18.0")
  throw new Error("Native assembly requires Linux x86_64 and Node 24.18.0");
if (execFileSync("npm", ["--version"], { encoding: "utf8" }).trim() !== "11.16.0")
  throw new Error("Native assembly requires npm 11.16.0");
if (execFileSync(opts["--bun"], ["--version"], { encoding: "utf8" }).trim() !== "1.4.0")
  throw new Error("Native assembly requires Bun 1.4.0");
if (execFileSync(opts["--uv"], ["--version"], { encoding: "utf8" }).trim().split(" ")[1] !== opts["--uv-version"])
  throw new Error("uv binary does not match the explicitly pinned version");
const sources = JSON.parse(readFileSync(opts["--sources"], "utf8"));
const prime = sources.primeAgent?.path;
const catalog = sources.primeCatalog?.path;
if (!prime || !catalog || !isAbsolute(prime) || !isAbsolute(catalog) ||
  !lstatSync(join(catalog, "models/catalog.v1.json")).isFile() ||
  !lstatSync(join(catalog, "plugins/catalog.v2.json")).isFile())
  throw new Error("Pinned patched Prime Agent and generated Prime catalog checkouts are required");
const pins = JSON.parse(readFileSync(new URL("../upstream/sources.json", import.meta.url), "utf8"));
for (const [name, pin] of Object.entries(pins)) {
  const source = sources[name];
  if (!source || !isAbsolute(source.path) || source.revision !== pin.revision ||
    source.patch !== pin.patch ||
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: source.path, encoding: "utf8" }).trim() !== pin.revision)
    throw new Error(`Native assembly requires pinned reviewed ${name} sources`);
  execFileSync("git", ["apply", "--reverse", "--check", fileURLToPath(new URL(`../${pin.patch}`, import.meta.url))],
    { cwd: source.path, stdio: "pipe" });
}
const pythonPrefix = opts["--python-prefix"];
validatePrefixAliases(pythonPrefix);
const python = join(pythonPrefix, "bin/python");
if (execFileSync(python, ["--version"], { encoding: "utf8" }).trim() !== "Python 3.14.7")
  throw new Error("A portable CPython 3.14.7 prefix is required");
const fullRequirements = fileURLToPath(new URL("../upstream/python-requirements.lock", import.meta.url));
const buildRequirements = fileURLToPath(new URL("../upstream/python-build-requirements.lock", import.meta.url));
if (!existsSync(fullRequirements) || !statSync(fullRequirements).isFile() ||
  statSync(fullRequirements).size === 0)
  throw new Error("Required full hash-pinned Prime kernel requirements lock is absent");
const locked = new Set([...readFileSync(fullRequirements, "utf8").matchAll(/^([A-Za-z0-9._-]+)==/gm)]
  .map((match) => match[1].toLowerCase().replaceAll("_", "-")));
for (const name of ["requests", "httpx", "pyyaml", "tomli", "python-dotenv", "pandas",
  "numpy", "scipy", "beautifulsoup4", "lxml", "pydantic", "tyro", "dill", "mcp"]) {
  if (!locked.has(name)) throw new Error(`Full pinned kernel requirements lack native package ${name}`);
}
const target = opts["--output"];
mkdirSync(resolve(target, ".."), { recursive: true });
mkdirSync(target);
const env = { ...process.env, HUSKY: "0", BUN_BINARY: opts["--bun"] };
function run(binary, args, cwd = prime) {
  execFileSync(binary, args, { cwd, env, stdio: "inherit" });
}
run("/usr/bin/cp", ["-aL", "--", fileURLToPath(new URL("../upstream/licenses", import.meta.url)),
  join(target, "UPSTREAM_LICENSES")]);
run("/usr/bin/cp", ["-aL", "--", fileURLToPath(new URL("../LICENSE", import.meta.url)),
  fileURLToPath(new URL("../NOTICE", import.meta.url)), join(target, "UPSTREAM_LICENSES")]);
const temporary = mkdtempSync(join(resolve(target, ".."), ".prime-native-assembly-"));
try {
  run("npm", ["ci"]);
  const codingAgent = join(prime, "packages/coding-agent");
  run("node", ["scripts/catalog-assets.mjs", "generate", "--catalog-dir", catalog,
    "--out", "catalog"], codingAgent);
  run("node", ["packages/coding-agent/scripts/build-binary.mjs", "--platform", "linux-x64"]);
  run("/usr/bin/cp", ["-aL", "--", `${join(codingAgent, "binaries/linux-x64")}/.`, target]);
  const kernel = join(target, "kernel-env");
  run("/usr/bin/cp", ["-aL", "--", pythonPrefix, kernel]);
  const relocatedPrefix = execFileSync(join(kernel, "bin/python"),
    ["-I", "-S", "-c", "import sys; print(sys.prefix)"], { encoding: "utf8" }).trim();
  if (relocatedPrefix !== kernel)
    throw new Error("Copied Python interpreter resolves outside its release prefix; refusing installation");
  const runtimeProject = join(prime, "prime-agent-runtime");
  run(opts["--uv"], ["pip", "install", "--python", join(kernel, "bin/python"),
    "--require-hashes", "--no-deps", "--reinstall-package", "pip",
    "--break-system-packages", "--requirements", fullRequirements]);
  const wheelDir = join(temporary, "wheels");
  mkdirSync(wheelDir, { mode: 0o700 });
  const buildEnv = join(temporary, "build-env");
  run(opts["--uv"], ["venv", "--python", join(kernel, "bin/python"), "--no-python-downloads", buildEnv]);
  const buildPython = join(buildEnv, "bin/python");
  run(opts["--uv"], ["pip", "install", "--python", buildPython, "--require-hashes",
    "--no-deps", "--requirements", buildRequirements]);
  run(opts["--uv"], ["build", "--python", buildPython, "--no-build-isolation",
    "--wheel", "--offline", "--out-dir", wheelDir], runtimeProject);
  const wheels = readdirSync(wheelDir).filter((name) => /^prime_agent_runtime-.*\.whl$/.test(name));
  if (wheels.length !== 1) throw new Error("Native kernel build requires exactly one real Prime runtime wheel");
  run(opts["--uv"], ["pip", "install", "--python", join(kernel, "bin/python"), "--no-index",
    "--find-links", wheelDir, "--no-deps", "--break-system-packages", "prime-agent-runtime==0.1.0"]);
  run("node", [join(resolve(import.meta.dirname, ".."), "scripts/collect-notices.mjs"),
    join(prime, "node_modules"), kernel, join(target, "THIRD_PARTY_LICENSES")]);
  const relocated = sanitizeKernel(kernel, [pythonPrefix, prime, catalog, temporary, target]);
  const relocationManifest = join(temporary, "relocated-scripts.json");
  writeFileSync(relocationManifest, JSON.stringify(relocated));
  run(join(kernel, "bin/python"), ["-B", fileURLToPath(new URL("./update-kernel-records.py", import.meta.url)),
    kernel, relocationManifest]);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
const digest = createHash("sha256");
function walk(dir) {
  for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
    const file = join(dir, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) throw new Error("Runtime contains an unsafe filesystem entry");
    const relativeName = relative(target, file).split(sep).join("/");
    if (stat.isDirectory()) { digest.update(`d\0${relativeName}\0`); walk(file); }
    else { digest.update(`f\0${relativeName}\0`); digest.update(readFileSync(file)); }
  }
}
walk(target);
const binary = join(target, "prime-agent");
console.log(JSON.stringify({ executable: binary, executableSha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  runtimeRoot: target, runtimeSha256: digest.digest("hex") }, null, 2));
