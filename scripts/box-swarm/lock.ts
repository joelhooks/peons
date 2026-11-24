import { randomUUID } from "node:crypto";
import { link, open, stat, unlink, writeFile } from "node:fs/promises";
import process from "node:process";

const codeIs = (error: unknown, code: string) => error instanceof Error && "code" in error && error.code === code;

const reapDeadLock = async (file: string, notify: (message: string) => void) => {
  const lock = await open(file, "r").catch((error: unknown) => {
    if (codeIs(error, "ENOENT")) { return null; }
    throw error;
  });
  if (lock === null) { return; }
  try {
    const lockText = await lock.readFile("utf-8");
    const owner = lockText.trim();
    const pid = Number(owner);
    if (!/^\d+$/u.test(owner) || !Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) {
      throw new Error(`Cannot verify the owner of ${file}; inspect the lock before removing it`);
    }
    try {
      process.kill(pid, 0);
      throw new Error(`Swarm is locked by live PID ${pid}`);
    } catch (error) {
      if (!codeIs(error, "ESRCH")) { throw error; }
    }
    const { dev, ino } = await lock.stat({ bigint: true });
    // Serialize reapers of this inode. A delayed reaper must not unlink a replacement lock.
    const claimPath = `${file}.reap-${dev}-${ino}`;
    const claim = await open(claimPath, "wx", 0o600);
    try {
      const current = await stat(file, { bigint: true }).catch((error: unknown) => {
        if (codeIs(error, "ENOENT")) { return null; }
        throw error;
      });
      if (current?.dev === dev && current.ino === ino) {
        await unlink(file);
        notify(`Cleared stale swarm lock from dead PID ${pid}: ${file}`);
      }
    } finally {
      await claim.close();
      await unlink(claimPath);
    }
  } finally {
    await lock.close();
  }
};

export const acquireLock = async (file: string, notify = console.error) => {
  const candidate = `${file}.${randomUUID()}.tmp`;
  await writeFile(candidate, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  try {
    try {
      // Publish the populated file atomically, so a contender never reads a partial PID.
      await link(candidate, file);
    } catch (error) {
      if (!codeIs(error, "EEXIST")) { throw error; }
      await reapDeadLock(file, notify);
      await link(candidate, file);
    }
  } finally {
    await unlink(candidate);
  }
  return async () => { await unlink(file); };
};
