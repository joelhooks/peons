import { lstat, mkdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";

const ensureDir = async (dir: string): Promise<string> => {
  await mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {throw error;}
  });
  const info = await lstat(dir);
  if (!info.isDirectory()) {throw new Error("peon output path component is not a directory");}
  return dir;
};

// Existing directories in a checkout can be symlinks. Don't follow one out of the desk's cwd.
export const writeOutputFile = async ({ cwd, path, text }: { readonly cwd: string; readonly path: string; readonly text: string }): Promise<void> => {
  const [peons, out, runId, ...rest] = nodePath.relative(cwd, nodePath.dirname(path)).split(nodePath.sep);
  if (peons !== ".peons" || out !== "out" || runId === undefined || rest.length !== 0) {throw new Error("invalid peon output directory");}
  const root = await ensureDir(nodePath.join(cwd, peons));
  const outputDir = await ensureDir(nodePath.join(root, out));
  await ensureDir(nodePath.join(outputDir, runId));
  await writeFile(path, text, { flag: "wx", mode: 0o600 });
};
