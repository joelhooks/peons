import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { evidenceCount, evidenceLimit, parseMatrix, parseOutput, parseSavedResult, WorkerRefusalError } from "./protocol.ts";
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

const spawn = async (worker: WorkerPort, input: Parameters<WorkerPort["spawn"]>[0], clock: Clock) => {
  let delay = 1000;
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- do not overlap spawn attempts for this peon
      return await worker.spawn(input);
    } catch (error) {
      if (!(error instanceof WorkerRefusalError && error.status === 429 && error.code === "CapacityFull")) { throw error; }
      // oxlint-disable-next-line no-await-in-loop -- wait before attempting another allocation
      await clock.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
};

// Inspect has no completed requestId. A matching pending request, a changed lastTurn
// under this runner's exclusive ownership, or the direct reply provides progress evidence.
const runTurn = async (worker: WorkerPort, before: Report, requestId: string, text: string, clock: Clock) => {
  const { peonId } = before;
  const abort = new AbortController();
  const fired: { report?: Report; error?: unknown } = {};
  let observed = false;
  let inspectError: unknown;
  const deadline = clock.now() + clock.turnTimeoutMs;
  const fire = async () => {
    try {
      fired.report = await worker.prompt({ peonId, requestId, text }, abort.signal);
    } catch (error) {
      fired.error = error;
    }
  };
  void fire();
  try {
    while (clock.now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop -- one inspect per polling interval
      await clock.sleep(clock.pollMs);
      if (definiteRefusal(fired.error)) { throw fired.error; }
      let report: Report;
      try {
        // oxlint-disable-next-line no-await-in-loop -- inspect the outcome before scheduling the next poll
        report = await worker.inspect(peonId);
      } catch (error) {
        if (definiteRefusal(error)) { throw error; }
        inspectError = error;
        continue;
      }
      if (definiteRefusal(fired.error)) { throw fired.error; }
      ensureAvailable(report);
      if (report.pending !== null && report.pending !== undefined) {
        if (report.pending.requestId !== requestId || report.pending.kind !== "prompt") {
          throw new Error(`Unexpected pending operation on ${peonId}: ${report.pending.kind}`);
        }
        observed = true;
        continue;
      }
      const { lastTurn } = report;
      const ack = fired.report;
      const acknowledged = ack !== undefined && ack.fault === null && (ack.pending === null || ack.pending === undefined) && isDeepStrictEqual(lastTurn, ack.lastTurn);
      if (lastTurn !== null && (observed || acknowledged || !isDeepStrictEqual(lastTurn, before.lastTurn))) {
        return { report, turn: lastTurn };
      }
    }
    const cause = inspectError ?? fired.error;
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

const runCell = async (options: RunOptions, matrix: Matrix, dir: string, cell: Matrix["cells"][number]): Promise<Entry> => {
  const { id } = cell;
  const { worker, swarmId, clock = realClock } = options;
  const peonId = `${swarmId}-${id}`;
  const cellDir = path.join(dir, id);
  const resultPath = path.join(cellDir, "result.json");
  const teardownPath = path.join(cellDir, "destroy.json");
  const spawnPath = path.join(cellDir, "spawned.json");
  try {
    const stored = await readSaved(resultPath);
    if (stored !== null) {
      const result = parseSavedResult(stored, id);
      const receipt = await readSaved(teardownPath);
      return receipt === null ? { result, resumed: true } : { result, resumed: true, teardown: parseTeardown(receipt) };
    }
  } catch (error) {
    return { result: fault(id, `Could not read saved result or receipt: ${message(error)}`), resumed: true };
  }

  await mkdir(cellDir, { mode: 0o700, recursive: true });
  let spawned = false;
  let result: Result;
  try {
    // Mischief's idempotent spawn can drive a pending operation on an existing box.
    // After the first spawn, inspect instead so a resume never replays a prompt.
    const spawnedReceipt = await readSaved(spawnPath);
    const expectedReceipt = json({ peonId });
    let report: Report;
    if (spawnedReceipt === expectedReceipt) {
      report = await worker.inspect(peonId);
    } else if (spawnedReceipt === null) {
      report = await spawn(worker, {
        overrides: { model: matrix.model, workspace: matrix.workspace },
        peonId,
        template: { name: matrix.template === "browser@1" ? "browser" : "full", version: 1 },
      }, clock);
      await save(spawnPath, expectedReceipt);
    } else {
      throw new Error("Invalid spawned.json; inspect the peon before rerunning");
    }
    spawned = true;
    result = await collect(options, cellDir, cell, report);
  } catch (error) {
    result = fault(id, error);
  }
  await save(resultPath, json(result));

  if (options.destroy !== true || !spawned) { return { result, resumed: false }; }
  let teardown: Teardown;
  try {
    await worker.destroy({ discardWorkspace: true, peonId });
    teardown = { status: "destroyed" };
  } catch (error) {
    const status = error instanceof WorkerRefusalError && error.code === "ReplicaPending" ? "replica-pending" : "fault";
    teardown = { reason: message(error), status };
  }
  await save(teardownPath, json(teardown));
  return { result, resumed: false, teardown };
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

export const runSwarm = async (options: RunOptions) => {
  const { root, swarmId } = options;
  const matrix = parseMatrix(options.input, swarmId);
  const dir = path.join(root, swarmId);
  await mkdir(dir, { mode: 0o700, recursive: true });
  const lockPath = path.join(dir, ".runner.lock");
  const lock = await open(lockPath, "wx", 0o600);
  try {
    await lock.writeFile(`${process.pid}\n`);
    const jobs = matrix.cells.entries();
    const entries: Entry[] = [];
    await Promise.all(Array.from({ length: Math.min(matrix.cells.length, matrix.concurrency) }, async () => {
      for (const [index, cell] of jobs) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- this worker holds one slot until the cell is accounted for
          entries[index] = await runCell(options, matrix, dir, cell);
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
    const summary = { cells, ...counts, swarmId };
    await save(path.join(dir, "summary.json"), json(summary));
    await save(path.join(dir, "SUMMARY.md"), [
      `# Box swarm ${swarmId}`, "", `${counts.pass} pass · ${counts.fail} fail · ${counts.fault} fault`, "",
      "| Cell | Result | Resumed | Notes | Teardown |", "| --- | --- | --- | --- | --- |", ...rows, "",
    ].join("\n"));
    return summary;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
};
