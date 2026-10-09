import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [modulesRoot, pythonRoot, output] = process.argv.slice(2);
if (!modulesRoot || !pythonRoot || !output) throw new Error("Usage: collect-notices.mjs NODE_MODULES PYTHON_PREFIX OUTPUT");
mkdirSync(output, { recursive: false, mode: 0o755 });
const entries = [];
const visited = new Set();
const seenDistributions = new Set();
const isNotice = /^(?:LICEN[CS]E|COPYING|NOTICE|AUTHORS|THIRD[_-]PARTY)(?:[._-].*)?$/i;
function copyNotices(source, distribution, names) {
  const identifier = createHash("sha256").update(distribution).digest("hex").slice(0, 16);
  const target = join(output, identifier);
  mkdirSync(target);
  const files = [];
  for (const name of names) {
    const path = join(source, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) continue;
    const publishedName = `${files.length}-${basename(name).replace(/[^A-Za-z0-9._-]/g, "_")}.txt`;
    writeFileSync(join(target, publishedName), readFileSync(path), { flag: "wx" });
    files.push(publishedName);
  }
  return files;
}
function modulePackage(directory) {
  const canonical = realpathSync(directory);
  if (visited.has(canonical)) return;
  visited.add(canonical);
  const manifest = join(directory, "package.json");
  if (!existsSync(manifest)) return;
  const metadata = JSON.parse(readFileSync(manifest, "utf8"));
  if (typeof metadata.name !== "string" || typeof metadata.version !== "string") return;
  const distribution = `npm:${metadata.name}@${metadata.version}`;
  if (!seenDistributions.has(distribution)) {
    seenDistributions.add(distribution);
    const licenses = readdirSync(directory).filter((name) => isNotice.test(name)).sort();
    entries.push({ distribution, declaredLicense: metadata.license ?? null,
      files: copyNotices(directory, distribution, licenses) });
  }
  const nested = join(directory, "node_modules");
  if (existsSync(nested)) nodeModules(nested);
}
function nodeModules(directory) {
  for (const name of readdirSync(directory).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(directory, name);
    if (name.startsWith("@")) {
      for (const scopedName of readdirSync(path).sort()) modulePackage(join(path, scopedName));
    } else modulePackage(path);
  }
}
nodeModules(modulesRoot);
const site = join(pythonRoot, "lib/python3.14/site-packages");
for (const name of readdirSync(site).sort()) {
  if (!name.endsWith(".dist-info")) continue;
  const directory = join(site, name);
  const metadata = readFileSync(join(directory, "METADATA"), "utf8");
  const licenseNames = readdirSync(directory).filter((item) => isNotice.test(item)).sort();
  const licenseRoot = join(directory, "licenses");
  if (existsSync(licenseRoot)) {
    function descend(current, prefix) {
      for (const item of readdirSync(current).sort()) {
        const file = join(current, item);
        if (lstatSync(file).isDirectory()) descend(file, `${prefix}${item}/`);
        else if (lstatSync(file).isFile()) licenseNames.push(`${prefix}${item}`);
      }
    }
    descend(licenseRoot, "licenses/");
  }
  const distribution = `python:${name}`;
  entries.push({ distribution,
    declaredLicense: metadata.match(/^License:\s*(.*)$/m)?.[1] ?? null,
    files: copyNotices(directory, distribution, licenseNames) });
}
entries.sort((a, b) => a.distribution.localeCompare(b.distribution));
writeFileSync(join(output, "INDEX.json"), `${JSON.stringify(entries, null, 2)}\n`, { flag: "wx" });
console.log(`Collected actual license/notice files for ${entries.length} native dependencies`);
