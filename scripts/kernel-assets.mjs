import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Reject aliases outside the portable Python prefix before copying with dereference. */
export function validatePrefixAliases(prefix) {
  const canonical = realpathSync(prefix);
  if (canonical !== prefix || !statSync(prefix).isDirectory())
    throw new Error("Portable Python prefix must be a canonical directory");
  function inspect(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(path);
        if (target !== canonical && !target.startsWith(`${canonical}/`))
          throw new Error("Portable Python prefix symlink resolves outside its pinned source");
      } else if (entry.isDirectory()) inspect(path);
      else if (!entry.isFile()) throw new Error("Portable Python prefix contains a special filesystem entry");
    }
  }
  inspect(prefix);
}

/** Installed scripts must point at their final managed mount, not the build machine. */
export function sanitizeKernel(kernel, sourcesToExclude) {
  const mountedRoot = "/opt/paperclip/runtime/kernel-env";
  const relocatedScripts = [];
  function visit(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("Portable native image still contains a symlink");
      if (stat.isDirectory()) {
        if (name === "__pycache__") rmSync(path, { recursive: true, force: true });
        else visit(path);
        continue;
      }
      if (!stat.isFile()) throw new Error("Portable native image contains a special filesystem entry");
      if (name.endsWith(".pyc")) { rmSync(path); continue; }
      if (name === "direct_url.json")
        throw new Error("Pinned Prime kernel cannot contain source-bearing direct_url metadata");
      if (name.endsWith(".pth")) {
        const text = readFileSync(path, "utf8");
        if (text.split(/\r?\n/).some((line) => line.startsWith("/") && !line.startsWith(`${mountedRoot}/`)) ||
          sourcesToExclude.some((source) => text.includes(source)))
          throw new Error("Kernel .pth contains a build-machine path");
      }
      if (directory === join(kernel, "bin") && stat.size < 64 * 1024) {
        const script = readFileSync(path, "utf8");
        const newline = script.indexOf("\n");
        const first = script.slice(0, newline);
        if (newline !== -1 &&
          /^#!(?:\S*\/python(?:3(?:\.14)?)?|\/usr\/bin\/env\s+python(?:3(?:\.14)?)?)(?:\s|$)/.test(first) &&
          first !== `#!${mountedRoot}/bin/python`) {
          writeFileSync(path, `#!${mountedRoot}/bin/python${script.slice(newline)}`);
          relocatedScripts.push(relative(kernel, path));
        }
      }
    }
  }
  visit(kernel);
  return relocatedScripts;
}
