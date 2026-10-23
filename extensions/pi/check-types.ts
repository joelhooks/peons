// pnpm check:pi: type-check extensions/ against the Pi this machine runs. The host provides
// @earendil-works/pi-coding-agent and typebox, so they are not dependencies here; this finds the
// installed package (PI_CODING_AGENT_DIR, else the pi launcher on PATH, else npm's global root),
// points tsc's paths at it from a throwaway config, and exits with tsc's status.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import nodePath from "node:path";

const PACKAGE = nodePath.join("@earendil-works", "pi-coding-agent");
const here = import.meta.dirname;
const root = nodePath.join(here, "..", "..");

const packageRoot = (path: string): string | null => {
  const at = path.indexOf(PACKAGE);
  return at === -1 ? null : path.slice(0, at + PACKAGE.length);
};

const fromLauncher = (): string | null => {
  for (const dir of (process.env.PATH ?? "").split(nodePath.delimiter)) {
    const launcher = nodePath.join(dir, "pi");
    if (!existsSync(launcher)) {continue;}
    const real = realpathSync(launcher);
    const linked = packageRoot(real);
    if (linked !== null) {return linked;}
    const text = readFileSync(real, "utf-8").replaceAll(/\$\{HOME\}|\$HOME/gu, homedir());
    const named = /[^\s"'=]*@earendil-works\/pi-coding-agent/u.exec(text)?.[0];
    if (named !== undefined) {return packageRoot(named);}
  }
  return null;
};

const fromNpm = (): string | null => {
  try {
    return nodePath.join(execFileSync("npm", ["root", "-g"], { encoding: "utf-8" }).trim(), PACKAGE);
  } catch {
    return null;
  }
};

const installed = (dir: string | null) => (dir !== null && existsSync(nodePath.join(dir, "package.json")) ? dir : null);
const found = installed(process.env.PI_CODING_AGENT_DIR ?? null) ?? installed(fromLauncher()) ?? installed(fromNpm());
if (found === null) {
  console.error(
    [
      "PiUnfound: you ran pnpm check:pi, and it failed because no installed @earendil-works/pi-coding-agent was found",
      "Accepted: PI_CODING_AGENT_DIR=<the package directory>, a pi launcher on PATH that names it, or a global npm install",
      "Fix: PI_CODING_AGENT_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent pnpm check:pi",
      "Debug: read extensions/pi/check-types.ts in joelhooks/peons",
    ].join("\n"),
  );
  process.exit(2);
}

// paths must name a declaration file: under nodenext a mapped directory does not resolve.
const typesOf = (dir: string): string | null => {
  const manifest: unknown = JSON.parse(readFileSync(nodePath.join(dir, "package.json"), "utf-8"));
  const types = typeof manifest === "object" && manifest !== null && "types" in manifest && typeof manifest.types === "string" ? manifest.types : null;
  return types === null ? null : nodePath.join(dir, types);
};
const sibling = (name: string) => [nodePath.join(found, "node_modules", name), nodePath.join(found, "..", "..", name)].find((dir) => existsSync(nodePath.join(dir, "package.json")));
const pi = typesOf(found);
const typeboxDir = sibling("typebox");
const typebox = typeboxDir === undefined ? null : typesOf(typeboxDir);
const dir = mkdtempSync(nodePath.join(tmpdir(), "peons-check-pi-"));
const config = nodePath.join(dir, "tsconfig.json");
writeFileSync(
  config,
  JSON.stringify({
    compilerOptions: {
      paths: { ...(pi === null ? {} : { "@earendil-works/pi-coding-agent": [pi] }), ...(typebox === null ? {} : { typebox: [typebox] }) },
      typeRoots: [nodePath.join(root, "node_modules", "@types")],
    },
    extends: nodePath.join(here, "tsconfig.json"),
  }),
);
const tsc = spawnSync(nodePath.join(root, "node_modules", ".bin", "tsc"), ["-p", config], { stdio: "inherit" });
rmSync(dir, { force: true, recursive: true });
console.error(`check:pi: ${tsc.status === 0 ? "ok" : "failed"} against ${found}`);
process.exit(tsc.status ?? 1);
