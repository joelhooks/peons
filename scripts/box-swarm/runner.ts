import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { acquireLock } from "./lock.ts";
import { evidenceCount, evidenceLimit, matrixDigest, parseMatrix, parseOutput, parseSavedResult, WorkerRefusalError } from "./protocol.ts";
import type { Matrix, Report, Result, WorkerPort } from "./protocol.ts";

interface Clock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs: number;
  readonly turnTimeoutMs: number;
}
const realClock: Clock = { now: () => performance.now(), pollMs: 5000, sleep: setTimeout, turnTimeoutMs: 30 * 60_000 };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const definiteRefusal = (error: unknown) => error instanceof WorkerRefusalError && (error.code !== undefined || error.status < 500);
const fault = (cell: string, error: unknown) => ({ cell, fault: message(error), pass: null });

const ensureAvailable = (report: Report) => {
  if (report.fault !== null) { throw new Error(report.fault); }
  if (report.state === "destroyed") { throw new Error("Peon is already destroyed; use a new swarm ID"); }
};

const spawn = async (worker: WorkerPort, input: Parameters<WorkerPort["spawn"]>[0], clock: Clock, capacityWaitMs: number) => {
  let delay = 1000;
  let deadline: number | undefined;
  const timedOut = () => new Error(`CapacityTimeout: no box available after ${capacityWaitMs} ms for ${input.peonId}`);
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- do not overlap spawn attempts for this peon
      return await worker.spawn(input);
    } catch (error) {
      if (!(error instanceof WorkerRefusalError && error.status === 429 && error.code === "CapacityFull")) { throw error; }
      deadline ??= clock.now() + capacityWaitMs;
      const remaining = deadline - clock.now();
      if (remaining <= 0) { throw timedOut(); }
      // oxlint-disable-next-line no-await-in-loop -- wait before attempting another allocation
      await clock.sleep(Math.min(delay, remaining));
      if (clock.now() >= deadline) { throw timedOut(); }
      delay = Math.min(delay * 2, 30_000);
    }
  }
};

// Inspect has no completed requestId. Under exclusive ownership, a changed
// lastTurn proves completion. Clearing pending alone does not prove it.
const runTurn = async (worker: WorkerPort, before: Report, requestId: string, text: string, clock: Clock) => {
  const { peonId } = before;
  const abort = new AbortController();
  let fireError: unknown;
  let observed = false;
  let inspectError: unknown;
  const deadline = clock.now() + clock.turnTimeoutMs;
  const fire = async () => {
    try {
      await worker.prompt({ peonId, requestId, text }, abort.signal);
    } catch (error) {
      fireError = error;
    }
  };
  void fire();
  try {
    while (clock.now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop -- one inspect per polling interval
      await clock.sleep(clock.pollMs);
      if (definiteRefusal(fireError)) { throw fireError; }
      let report: Report;
      try {
        // oxlint-disable-next-line no-await-in-loop -- inspect the outcome before scheduling the next poll
        report = await worker.inspect(peonId);
      } catch (error) {
        if (definiteRefusal(error)) { throw error; }
        inspectError = error;
        continue;
      }
      if (definiteRefusal(fireError)) { throw fireError; }
      ensureAvailable(report);
      if (report.pending !== null && report.pending !== undefined) {
        if (report.pending.requestId !== requestId || report.pending.kind !== "prompt") {
          throw new Error(`Unexpected pending operation on ${peonId}: ${report.pending.kind}`);
        }
        observed = true;
        continue;
      }
      const { lastTurn } = report;
      if (lastTurn !== null && !isDeepStrictEqual(lastTurn, before.lastTurn)) {
        return { report, turn: lastTurn };
      }
      if (observed) { throw new Error(`TurnLost: ${requestId} cleared without a new lastTurn`); }
    }
    const cause = inspectError ?? fireError;
    throw new Error(`No confirmed completion for ${requestId} before the polling deadline${cause === undefined ? "" : `: ${message(cause)}`}`);
  } finally {
    abort.abort();
  }
};

const save = async (destination: string, contents: string | Uint8Array) => {
  const temp = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, contents, { flag: "wx", mode: 0o600 });
    await rename(temp, destination);
  } catch (error) {
    await unlink(temp).catch(() => null);
    throw error;
  }
};
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

interface RunOptions {
  readonly clock?: Clock;
  readonly destroy?: boolean;
  readonly input: unknown;
  readonly root: string;
  readonly swarmId: string;
  readonly worker: WorkerPort;
}
type Teardown = { readonly status: "destroyed" } | { readonly status: "replica-pending" | "fault"; readonly reason: string };
interface Entry {
  readonly result: Result;
  readonly resumed: boolean;
  readonly teardown?: Teardown;
}

const promptFor = (text: string, id: string, index: number, total: number) => {
  const instruction = index + 1 < total
    ? "Do only the work for this turn. Leave a short handoff for the next turn."
    : `End with one JSON line and no code fences: {"cell":"${id}","pass":true,"failedStep":"optional if false","notes":"short text","evidence":[{"name":"file.png","mime":"image/png","base64":"..."}]}. Use a boolean pass, omit failedStep when not applicable, and return 0 to ${evidenceCount} evidence items, each at most ${evidenceLimit} decoded bytes, with distinct plain filenames.`;
  return `Matrix cell ${id}, turn ${index + 1}/${total}. ${instruction}\n\n${text}\n\n${instruction}`;
};

const readSaved = async (file: string) => {
  try {
    return await readFile(file, "utf-8");
  } catch (error) {
    if (missing(error)) { return null; }
    throw error;
  }
};

const collect = async (options: RunOptions, cellDir: string, cell: Matrix["cells"][number], initial: Report) => {
  ensureAvailable(initial);
  if (initial.pending !== undefined && initial.pending !== null) {
    throw new Error(`Peon already has a pending ${initial.pending.kind}; inspect before a new attempt`);
  }
  if (!["idle", "suspended", "hibernated"].includes(initial.state)) {
    throw new Error(`Peon is not ready (${initial.state}); inspect before a new attempt`);
  }
  let report = initial;
  const { id } = cell;
  const { worker, clock = realClock } = options;
  const texts = [cell.brief, ...(cell.turns ?? [])];
  const tail = async (output: string) => { await save(path.join(cellDir, "raw-tail.txt"), output.slice(-16_384)); };
  let output = "";
  for (const [index, text] of texts.entries()) {
    const requestId = `${initial.peonId}-${index + 1}-${randomUUID()}`;
    // oxlint-disable-next-line no-await-in-loop -- the next turn needs this turn's workspace and conversation
    const done = await runTurn(worker, report, requestId, promptFor(text, id, index, texts.length), clock);
    const { turn } = done;
    if (turn.exit !== 0) {
      // oxlint-disable-next-line no-await-in-loop -- retain the failed turn's output before recording the fault
      await tail(turn.output);
      throw new Error(`Turn ${index + 1} exited ${turn.exit}; see raw-tail.txt`);
    }
    ({ report } = done);
    ({ output } = turn);
  }
  let parsed: ReturnType<typeof parseOutput>;
  try {
    parsed = parseOutput(output, id);
  } catch (error) {
    await tail(output);
    throw error;
  }
  if (parsed.files.length > 0) {
    const evidenceDir = path.join(cellDir, "evidence");
    await mkdir(evidenceDir, { mode: 0o700, recursive: true });
    const writes = await Promise.allSettled(parsed.files.map(async ({ bytes, name }) => { await save(path.join(evidenceDir, name), bytes); }));
    for (const write of writes) {
      if (write.status === "rejected") { throw new Error(`Could not write evidence: ${message(write.reason)}`); }
    }
  }
  return parsed.result;
};

const finish = async (options: RunOptions, cellDir: string, peonId: string, spawned: boolean): Promise<Teardown | null> => {
  const teardownPath = path.join(cellDir, "destroy.json");
  const receipt = await readSaved(teardownPath);
  if (receipt !== null) { return parseTeardown(receipt); }
  if (options.destroy !== true || !spawned) { return null; }
  // A crash after this write leaves an ambiguous attempt, never an automatic retry.
  await save(teardownPath, json({ reason: "Destroy not confirmed after interruption; inspect the peon before acting", status: "fault" }));
  let teardown: Teardown;
  try {
    await options.worker.destroy({ discardWorkspace: true, peonId });
    teardown = { status: "destroyed" };
  } catch (error) {
    const status = error instanceof WorkerRefusalError && error.code === "ReplicaPending" ? "replica-pending" : "fault";
    teardown = { reason: message(error), status };
  }
  await save(teardownPath, json(teardown));
  return teardown;
};

const runCell = async (options: RunOptions, matrix: Matrix, dir: string, cell: Matrix["cells"][number], digest: string, saved: Result | undefined): Promise<Entry> => {
  const { id } = cell;
  const { worker, swarmId, clock = realClock } = options;
  const peonId = `${swarmId}-${id}`;
  const cellDir = path.join(dir, id);
  const spawnPath = path.join(cellDir, "spawned.json");
  const expectedReceipt = json({ peonId });
  const spawnedReceipt = await readSaved(spawnPath);
  let spawned = spawnedReceipt === expectedReceipt;
  let result: Result;
  if (saved === undefined) {
    await mkdir(cellDir, { mode: 0o700, recursive: true });
    try {
      let report: Report;
      if (spawned) {
        // Idempotent spawn can drive a pending operation; inspect so we never replay a prompt.
        report = await worker.inspect(peonId);
      } else if (spawnedReceipt === null) {
        // Mischief binds spawn/<peonId> internally; a crash before the receipt repeats that exact operation.
        report = await spawn(worker, {
          overrides: { model: matrix.model, workspace: matrix.workspace },
          peonId,
          template: { name: matrix.template === "browser@1" ? "browser" : "full", version: 1 },
        }, clock, matrix.capacityWaitMs);
        await save(spawnPath, expectedReceipt);
        spawned = true;
      } else {
        throw new Error("Invalid spawned.json; inspect the peon before rerunning");
      }
      result = await collect(options, cellDir, cell, report);
    } catch (error) {
      result = fault(id, error);
    }
    await save(path.join(cellDir, "result.json"), json({ ...result, matrixSha256: digest }));
  } else {
    result = saved;
  }
  const teardown = await finish(options, cellDir, peonId, spawned).catch((error: unknown): Teardown => ({ reason: message(error), status: "fault" }));
  return { result, resumed: saved !== undefined, ...(teardown === null ? {} : { teardown }) };
};

const parseTeardown = (text: string): Teardown => {
  const value: unknown = JSON.parse(text);
  if (typeof value === "object" && value !== null && "status" in value) {
    if (value.status === "destroyed") { return { status: "destroyed" }; }
    if ((value.status === "fault" || value.status === "replica-pending") && "reason" in value && typeof value.reason === "string") {
      return { reason: value.reason, status: value.status };
    }
  }
  throw new Error("Invalid destroy.json");
};

const md = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "&#124;").replaceAll(/\s+/gu, " ");
const teardownText = (teardown: Teardown | undefined) => {
  if (teardown === undefined) { return "—"; }
  return teardown.status === "destroyed" ? "destroyed" : teardown.reason;
};

const outcomeOf = (pass: boolean | null) => {
  if (pass === null) { return "fault"; }
  return pass ? "pass" : "fail";
};

const bindMatrix = async (matrix: Matrix, dir: string, swarmId: string) => {
  const digest = matrixDigest(matrix);
  const digestPath = path.join(dir, "matrix.sha256");
  const previous = await readSaved(digestPath);
  let maxLength = 39;
  for (const { id } of matrix.cells) { maxLength = Math.min(maxLength, 39 - id.length); }
  const proposal = `${swarmId}-next`.slice(0, maxLength);
  const next = proposal === swarmId ? `${swarmId.startsWith("a") ? "b" : "a"}${swarmId.slice(1)}` : proposal;
  const refuse = (reason: string) => new Error(`${reason}; use a new swarm ID, e.g. ${next}`);
  if (previous !== null && previous.trim() !== digest) { throw refuse(`Matrix digest does not match swarm ${swarmId}`); }
  if (previous === null) {
    const existing = await readdir(dir, { withFileTypes: true });
    if (existing.some((file) => !file.name.startsWith(".runner.lock") && !/^matrix\.sha256\.[a-f\d-]+\.tmp$/u.test(file.name))) {
      throw refuse(`Swarm ${swarmId} already has artifacts but no matrix digest`);
    }
    await save(digestPath, `${digest}\n`);
  }
  const saved = new Map<string, Result>();
  // Preflight all results before starting more work or replacing either summary.
  for (const { id } of matrix.cells) {
    // oxlint-disable-next-line no-await-in-loop -- read one saved result at a time to bound IO
    const text = await readSaved(path.join(dir, id, "result.json"));
    if (text === null) { continue; }
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw refuse(`Cell ${id} has unreadable result JSON`); }
    if (typeof value !== "object" || value === null || !("matrixSha256" in value) || value.matrixSha256 !== digest) {
      throw refuse(`Cell ${id} has a missing or different matrix digest`);
    }
    saved.set(id, parseSavedResult(value, id));
  }
  return { digest, saved };
};

export const runSwarm = async (options: RunOptions) => {
  const { root, swarmId } = options;
  const matrix = parseMatrix(options.input, swarmId);
  const dir = path.join(root, swarmId);
  await mkdir(dir, { mode: 0o700, recursive: true });
  const release = await acquireLock(path.join(dir, ".runner.lock"));
  try {
    const { digest, saved } = await bindMatrix(matrix, dir, swarmId);
    const jobs = matrix.cells.entries();
    const entries: Entry[] = [];
    await Promise.all(Array.from({ length: Math.min(matrix.cells.length, matrix.concurrency) }, async () => {
      for (const [index, cell] of jobs) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- this worker holds one slot until the cell is accounted for
          entries[index] = await runCell(options, matrix, dir, cell, digest, saved.get(cell.id));
        } catch (error) {
          entries[index] = { result: fault(cell.id, error), resumed: false };
        }
      }
    }));
    const cells = entries.map(({ result, resumed, teardown }) => result.pass === null
      ? { cell: result.cell, fault: result.fault, pass: result.pass, resumed, teardown }
      : { cell: result.cell, failedStep: result.failedStep, notes: result.notes, pass: result.pass, resumed, teardown });
    const counts = { fail: 0, fault: 0, pass: 0 };
    const rows = cells.map((cell) => {
      const outcome = outcomeOf(cell.pass);
      counts[outcome] += 1;
      const detail = "fault" in cell ? cell.fault : [cell.failedStep, cell.notes].filter(Boolean).join(": ");
      return `| ${cell.cell} | ${outcome} | ${cell.resumed ? "yes" : "no"} | ${md(detail)} | ${md(teardownText(cell.teardown))} |`;
    });
    const summary = { cells, ...counts, matrixSha256: digest, swarmId };
    await save(path.join(dir, "summary.json"), json(summary));
    await save(path.join(dir, "SUMMARY.md"), [
      `# Box swarm ${swarmId}`, "", `${counts.pass} pass · ${counts.fail} fail · ${counts.fault} fault`, "",
      "| Cell | Result | Resumed | Notes | Teardown |", "| --- | --- | --- | --- | --- |", ...rows, "",
    ].join("\n"));
    return summary;
  } finally {
    await release();
  }
};
