import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setImmediate, setTimeout } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { evidenceLimit, matrixDigest, parseMatrix, WorkerRefusalError } from "../scripts/box-swarm/protocol.ts";
import type { Report, WorkerPort } from "../scripts/box-swarm/protocol.ts";
import { runSwarm } from "../scripts/box-swarm/runner.ts";

const swarmId = "suite";
const idFor = (peonId: string) => peonId.slice(swarmId.length + 1);
const cell = (id: string) => ({ brief: `Run ${id}.`, id });
const matrix = (ids: string[]) => ({ cells: ids.map(cell), model: "sol", template: "full@1", turnBudget: 2, workspace: { repo: "joelhooks/peons", sha: "a".repeat(40) } });
const verdict = (id: string, pass = true, evidence: unknown[] = []) => JSON.stringify({ cell: id, evidence, notes: "checked", pass });
const report = (peonId: string, lastTurn: Report["lastTurn"] = null): Report => ({ fault: null, lastTurn, pending: null, peonId, state: "idle" });
const item = (name: string, size = 1) => ({ base64: Buffer.alloc(size, 97).toString("base64"), mime: "text/plain", name });

const fakeWorker = (output = verdict) => {
  const active = new Set<string>();
  const pending = new Map<string, string>();
  const done = new Map<string, Report>();
  const stats = { max: 0, started: 0 };
  const worker = {
    destroy: vi.fn<WorkerPort["destroy"]>(async ({ peonId }) => { await setImmediate(); active.delete(peonId); }),
    inspect: vi.fn<WorkerPort["inspect"]>(async (peonId) => {
      await setImmediate();
      const requestId = pending.get(peonId);
      const previous = done.get(peonId) ?? report(peonId);
      if (requestId === undefined) { return previous; }
      pending.delete(peonId);
      const next = report(peonId, { exit: 0, output: output(idFor(peonId)), usage: { total: 42 }, wallMs: 1 + (previous.lastTurn?.wallMs ?? 0) });
      done.set(peonId, next);
      return { ...previous, pending: { kind: "prompt", requestId }, state: "running" };
    }),
    // Simulate a long HTTP response that never settles until the runner aborts it.
    prompt: vi.fn<WorkerPort["prompt"]>(async ({ peonId, requestId }, signal) => {
      pending.set(peonId, requestId);
      await setTimeout(120_000, null, { signal });
      throw new Error("Test did not abort the open prompt request");
    }),
    spawn: vi.fn<WorkerPort["spawn"]>(async ({ peonId }) => {
      await setImmediate();
      // Mischief deduplicates by its internal request ID, spawn/<peonId>.
      if (!active.has(peonId)) { stats.started += 1; }
      active.add(peonId);
      stats.max = Math.max(stats.max, active.size);
      return done.get(peonId) ?? report(peonId);
    }),
  };
  return { stats, worker };
};

let root: string;
let elapsed: number;
let delays: number[];
const testClock = {
  now: () => elapsed,
  pollMs: 1,
  sleep: async (ms: number) => {
    delays.push(ms);
    elapsed += ms;
    await setImmediate();
  },
  turnTimeoutMs: 50,
};

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "box-swarm-")); elapsed = 0; delays = []; });
afterEach(async () => { await rm(root, { force: true, recursive: true }); });
const run = async (worker: WorkerPort, input: unknown, destroy = false) => await runSwarm({ clock: testClock, destroy, input, root, swarmId, worker });
const file = async (...parts: string[]) => await readFile(path.join(root, swarmId, ...parts), "utf-8");

describe("box swarm", () => {
  it("holds one slot per cell through all turns and teardown; polls while the prompt call is still open", async () => {
    const { stats, worker } = fakeWorker();
    const input = { ...matrix(["a", "b", "c", "d"]), cells: [{ ...cell("a"), turns: ["Finish the test."] }, ...["b", "c", "d"].map(cell)], concurrency: 2 };
    const summary = await run(worker, input, true);
    expect(summary).toMatchObject({ fail: 0, fault: 0, pass: 4 });
    expect(stats.max).toBe(2);
    expect(worker.prompt).toHaveBeenCalledTimes(5);
    expect(worker.inspect).toHaveBeenCalledTimes(10);
    expect(worker.prompt.mock.calls.filter(([value]) => value.peonId === "suite-a").map(([value]) => value.text)).toEqual([
      expect.stringContaining("turn 1/2"), expect.stringContaining("Finish the test."),
    ]);
    expect(worker.prompt.mock.calls.every(([, signal]) => signal.aborted)).toBe(true);
    expect(worker.destroy).toHaveBeenCalledTimes(4);
    expect(worker.destroy).toHaveBeenCalledWith({ discardWorkspace: true, peonId: "suite-a" });
    expect(await file("SUMMARY.md")).toContain("4 pass · 0 fail · 0 fault");
    expect(await file("summary.json")).toContain('"pass": 4');
  });

  it("isolates a prompt fault, records a valid failure, and never reuses the request ID", async () => {
    const { worker } = fakeWorker((id) => verdict(id, id !== "b"));
    worker.prompt.mockRejectedValueOnce(new WorkerRefusalError(409, "BoxLost", "turn failed"));
    const input = { ...matrix(["a", "b", "c"]), concurrency: 1 };
    expect(await run(worker, input)).toMatchObject({ fail: 1, fault: 1, pass: 1 });
    expect(await file("a", "result.json")).toContain("BoxLost: turn failed");
    expect(worker.prompt).toHaveBeenCalledTimes(3);
    await unlink(path.join(root, swarmId, "a", "result.json"));
    expect(await run(worker, input)).toMatchObject({ fail: 1, fault: 0, pass: 2 });
    expect(worker.prompt).toHaveBeenCalledTimes(4);
    const ids = worker.prompt.mock.calls.filter(([value]) => value.peonId === "suite-a").map(([value]) => value.requestId);
    expect(new Set(ids).size).toBe(2);
    expect(worker.spawn.mock.calls.map(([value]) => value.peonId)).toEqual(["suite-a", "suite-b", "suite-c"]);
    expect(worker.inspect).toHaveBeenCalledWith("suite-a");
  });

  it("resumes without spawning, prompting or repeating teardown, even for ReplicaPending", async () => {
    const { worker } = fakeWorker();
    worker.destroy.mockRejectedValueOnce(new WorkerRefusalError(422, "ReplicaPending", "second copy not verified"));
    const input = matrix(["a"]);
    const first = await run(worker, input, true);
    expect(first.cells[0]).toMatchObject({ pass: true, teardown: { reason: "ReplicaPending: second copy not verified", status: "replica-pending" } });
    const saved = await file("a", "result.json");
    const second = await run(worker, input, true);
    expect(second.cells[0]).toMatchObject({ pass: true, resumed: true, teardown: { status: "replica-pending" } });
    expect(await file("a", "result.json")).toBe(saved);
    expect(worker.spawn).toHaveBeenCalledTimes(1);
    expect(worker.prompt).toHaveBeenCalledTimes(1);
    expect(worker.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(["not JSON", '{"cell":"not-a","pass":true,"notes":"wrong id","evidence":[]}', '{"cell":"a","pass":"yes","notes":"wrong type","evidence":[]}'])("saves the raw tail for invalid output: %s", async (tail) => {
    const { worker } = fakeWorker(() => `log line\n${tail}\n`);
    expect(await run(worker, matrix(["a"]))).toMatchObject({ fault: 1, pass: 0 });
    expect(await file("a", "result.json")).toContain('"pass": null');
    expect(await file("a", "raw-tail.txt")).toContain(tail);
  });

  it("keeps four pieces of evidence at the limit and rejects oversized, excess, invalid base64 and unsafe names", async () => {
    const evidence = new Map([
      ["valid", Array.from({ length: 4 }, (_, index) => item(`${index}.txt`, evidenceLimit))],
      ["oversize", [item("too-large.txt", evidenceLimit + 1)]],
      ["excess", Array.from({ length: 5 }, (_, index) => item(`${index}.txt`))],
      ["invalid", [{ ...item("bad.txt"), base64: "YQ==$" }]],
      ["escape", [item("../oops.txt")]],
      ["duplicate", [item("A.txt"), item("a.txt")]],
    ]);
    const { worker } = fakeWorker((id) => verdict(id, true, evidence.get(id)));
    expect(await run(worker, matrix([...evidence.keys()]))).toMatchObject({ fault: 5, pass: 1 });
    const evidenceDir = path.join(root, swarmId, "valid", "evidence");
    expect(await readdir(evidenceDir)).toHaveLength(4);
    expect(await readFile(path.join(evidenceDir, "0.txt"))).toEqual(Buffer.alloc(evidenceLimit, 97));
    expect(await readdir(path.join(root, swarmId, "oversize"))).toEqual(["raw-tail.txt", "result.json", "spawned.json"]);
  });

  it("waits on a coded CapacityFull 429 with backoff, preserving the peon ID", async () => {
    const { worker } = fakeWorker();
    const refusal = new WorkerRefusalError(429, "CapacityFull", "all boxes in use");
    worker.spawn.mockRejectedValueOnce(refusal).mockRejectedValueOnce(refusal);
    const input = { ...matrix(["a"]), template: "browser@1" };
    expect(await run(worker, input)).toMatchObject({ fault: 0, pass: 1 });
    expect(delays).toEqual([1000, 2000, 1, 1]);
    expect(worker.spawn.mock.calls.map(([value]) => [value.peonId, value.template])).toEqual(Array.from({ length: 3 }, () => ["suite-a", { name: "browser", version: 1 }]));
  });

  it("records SpendCap 429 as a cell fault without retrying", async () => {
    const { worker } = fakeWorker();
    worker.spawn.mockRejectedValueOnce(new WorkerRefusalError(429, "SpendCap", "daily budget reached"));
    expect(await run(worker, { ...matrix(["a", "b"]), concurrency: 1 })).toMatchObject({ fault: 1, pass: 1 });
    expect(await file("a", "result.json")).toContain("SpendCap: daily budget reached");
    expect(worker.spawn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1, 1]);
  });

  it("inspects an interrupted cell instead of replaying its pending prompt through idempotent spawn", async () => {
    const { worker } = fakeWorker();
    const input = matrix(["a"]);
    await run(worker, input);
    await unlink(path.join(root, swarmId, "a", "result.json"));
    worker.inspect.mockResolvedValue({ ...report("suite-a"), pending: { kind: "prompt", requestId: "old" }, state: "running" });
    expect(await run(worker, input)).toMatchObject({ fault: 1, pass: 0 });
    expect(await file("a", "result.json")).toContain("already has a pending prompt");
    expect(worker.spawn).toHaveBeenCalledTimes(1);
    expect(worker.prompt).toHaveBeenCalledTimes(1);
  });

  it("does not accept a stale lastTurn when a dropped prompt never started", async () => {
    const { worker } = fakeWorker();
    const old = report("suite-a", { exit: 0, output: verdict("a"), usage: { total: 42 }, wallMs: 1 });
    worker.spawn.mockResolvedValue(old);
    worker.inspect.mockResolvedValue(old);
    worker.prompt.mockRejectedValue(new Error("connection dropped"));
    expect(await run(worker, matrix(["a"]))).toMatchObject({ fault: 1, pass: 0 });
    expect(await file("a", "result.json")).toContain("No confirmed completion");
    expect(worker.prompt).toHaveBeenCalledTimes(1);
  });

  it("records TurnLost when the matching pending prompt clears but its previous turn is unchanged", async () => {
    const { worker } = fakeWorker();
    const old = report("suite-a", { exit: 0, output: verdict("a"), usage: { total: 42 }, wallMs: 1 });
    worker.spawn.mockResolvedValue(old);
    worker.inspect.mockImplementationOnce(async () => {
      await setImmediate();
      const requestId = worker.prompt.mock.calls[0]?.[0].requestId;
      if (requestId === undefined) { throw new Error("Expected a prompt before inspect"); }
      return { ...old, pending: { kind: "prompt", requestId }, state: "running" };
    }).mockResolvedValue(old);
    expect(await run(worker, matrix(["a"]))).toMatchObject({ fault: 1, pass: 0 });
    expect(await file("a", "result.json")).toContain("TurnLost:");
    expect(worker.inspect).toHaveBeenCalledTimes(2);
  });

  it("accepts completion through inspect exactly once after the prompt connection drops", async () => {
    const { worker } = fakeWorker();
    const completed = report("suite-a", { exit: 0, output: verdict("a"), usage: { total: 42 }, wallMs: 1 });
    worker.prompt.mockRejectedValueOnce(new Error("connection dropped"));
    worker.inspect.mockResolvedValueOnce(completed);
    expect(await run(worker, matrix(["a"]))).toMatchObject({ fault: 0, pass: 1 });
    expect(worker.prompt).toHaveBeenCalledTimes(1);
    expect(worker.inspect).toHaveBeenCalledTimes(1);
  });

  it("refuses changed matrix contents and any cell result with a different digest before making calls", async () => {
    const { worker } = fakeWorker();
    const input = matrix(["a", "b"]);
    const first = await run(worker, input);
    expect(await file("matrix.sha256")).toBe(`${first.matrixSha256}\n`);
    const original = await file("summary.json");
    const saved = await file("a", "result.json");
    expect(saved).toContain(first.matrixSha256);
    await expect(run(worker, { ...input, cells: [{ ...cell("a"), turns: ["different"] }, cell("b")] })).rejects.toThrow("use a new swarm ID, e.g. suite-next");
    await writeFile(path.join(root, swarmId, "a", "result.json"), saved.replace(first.matrixSha256, "0".repeat(64)));
    await expect(run(worker, input)).rejects.toThrow("Cell a has a missing or different matrix digest");
    expect(await file("summary.json")).toBe(original);
    expect(worker.spawn).toHaveBeenCalledTimes(2);
    expect(worker.prompt).toHaveBeenCalledTimes(2);
  });

  it("releases a slot after the capacity wait expires and always writes the summary", async () => {
    const { worker } = fakeWorker();
    const spawn = worker.spawn.getMockImplementation();
    if (spawn === undefined) { throw new Error("Missing fake spawn implementation"); }
    worker.spawn.mockImplementation(async (input) => {
      if (input.peonId === "suite-a") { throw new WorkerRefusalError(429, "CapacityFull", "all boxes in use"); }
      return await spawn(input);
    });
    expect(await run(worker, { ...matrix(["a", "b"]), capacityWaitMs: 2500, concurrency: 1 })).toMatchObject({ fault: 1, pass: 1 });
    expect(delays).toEqual([1000, 1500, 1, 1]);
    expect(await file("a", "result.json")).toContain("CapacityTimeout:");
    expect(await file("SUMMARY.md")).toContain("1 pass · 0 fail · 1 fault");
  });

  it("reattaches after a crash between remote spawn and the local spawn receipt", async () => {
    const { stats, worker } = fakeWorker();
    const input = matrix(["a"]);
    const spawn = { overrides: { model: input.model, workspace: input.workspace }, peonId: "suite-a", template: { name: "full", version: 1 } } satisfies Parameters<WorkerPort["spawn"]>[0];
    // Simulate the remote side having committed spawn/suite-a before the client persisted spawned.json.
    await mkdir(path.join(root, swarmId, "a"), { recursive: true });
    await writeFile(path.join(root, swarmId, "matrix.sha256"), `${matrixDigest(parseMatrix(input, swarmId))}\n`);
    await worker.spawn(spawn);
    expect(await run(worker, input)).toMatchObject({ fault: 0, pass: 1 });
    expect(worker.spawn.mock.calls).toEqual([[spawn], [spawn]]);
    expect(stats.started).toBe(1);
    expect(worker.prompt).toHaveBeenCalledTimes(1);
  });

  it("runs only missing teardown after a crash with result.json already saved", async () => {
    const { worker } = fakeWorker();
    const input = matrix(["a"]);
    // This is the on-disk state of a crash after result.json, before a discard attempt.
    await run(worker, input);
    const saved = await file("a", "result.json");
    const resumed = await run(worker, input, true);
    expect(resumed.cells[0]).toMatchObject({ pass: true, resumed: true, teardown: { status: "destroyed" } });
    expect(await file("a", "result.json")).toBe(saved);
    expect(worker.spawn).toHaveBeenCalledTimes(1);
    expect(worker.prompt).toHaveBeenCalledTimes(1);
    expect(worker.inspect).toHaveBeenCalledTimes(2);
    expect(worker.destroy).toHaveBeenCalledExactlyOnceWith({ discardWorkspace: true, peonId: "suite-a" });
  });

  it("clears a dead PID lock with a message and never steals a live lock", async () => {
    const { worker } = fakeWorker();
    const input = matrix(["a"]);
    await mkdir(path.join(root, swarmId));
    const lock = path.join(root, swarmId, ".runner.lock");
    await writeFile(lock, `${process.pid}\n`);
    await expect(run(worker, input)).rejects.toThrow(`locked by live PID ${process.pid}`);
    expect(await file(".runner.lock")).toBe(`${process.pid}\n`);
    expect(worker.spawn).not.toHaveBeenCalled();
    const child = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
    expect(child.status).toBe(0);
    await writeFile(lock, `${child.pid}\n`);
    const logging = vi.spyOn(console, "error").mockImplementation(() => {
      // Capture the recovery notice instead of printing it during the test.
    });
    try {
      expect(await run(worker, input)).toMatchObject({ fault: 0, pass: 1 });
      expect(logging).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`Cleared stale swarm lock from dead PID ${child.pid}`));
      expect(await readdir(path.join(root, swarmId))).not.toContain(".runner.lock");
    } finally {
      logging.mockRestore();
    }
  });

  it("uses template defaults and rejects unsafe IDs and over-budget cells before spawning", () => {
    const input = matrix(["a"]);
    expect(parseMatrix(input, swarmId)).toMatchObject({ capacityWaitMs: 30 * 60_000, concurrency: 8 });
    expect(parseMatrix({ ...input, template: "browser@1" }, swarmId).concurrency).toBe(6);
    expect(() => parseMatrix(input, "../x")).toThrow("Invalid swarm ID");
    expect(parseMatrix(matrix(["c"]), "a-b").cells[0]?.id).toBe("c");
    expect(() => parseMatrix(matrix(["b-c"]), "a")).toThrow();
    expect(() => parseMatrix(matrix(["a", "a"]), swarmId)).toThrow("Duplicate cell ID");
    expect(() => parseMatrix({ ...input, cells: [{ ...cell("a"), turns: ["b", "c"] }] }, swarmId)).toThrow("exceeds turnBudget");
  });
});
