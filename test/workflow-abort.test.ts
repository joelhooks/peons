import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { describe, expect, it } from "vitest";

import { Prompt } from "../src/compile.ts";
import { defineWorkflow } from "../src/workflow.ts";
import { defineComposition, reconcile } from "../src/workflow-v2.ts";
import type { Attempt } from "../src/workflow-v2.ts";
import { DESK, catalog, fakeHost, forAll, int, memoryFiles, pick, run, toolsWith } from "./support.ts";

const unwrap = <A>(value: A | Prompt): A => {
  if (value instanceof Prompt) {throw new TypeError(value.message);}
  return value;
};
const terminal = new Set(["done", "amendment-refused", "aborted", "failed"]);
const composed = (cap: number, depth = 1) => {
  const nested = unwrap(defineWorkflow({ desk: DESK, id: "nested", schema: "peons.workflow.v1", steps: Array.from({ length: depth }, (_, index) => ({ id: `s${index}`, input: { from: ["input"], text: "Review" }, kind: "peon", workType: "scan" })), version: 1 }, catalog));
  return { desk: DESK, id: "halts", retryCap: cap, schema: "peons.workflow.v2", steps: [
    { id: "judge", kind: "map", over: { from: "input.batches" }, task: { input: { docs: { batch: { from: "batch" } }, text: "Return batch verdicts" }, kind: "workflow", workflow: nested } },
    { from: "judge", id: "collect", kind: "gather", writes: "verdicts" },
  ], version: 1 };
};
const inputOf = (count: number) => ({ batches: Array.from({ length: count }, (_, index) => [{ id: `item${index}` }]) });
const reportsOf = (fake: ReturnType<typeof fakeHost>) => Object.fromEntries([...fake.runs].map(([id, { report }]) => [id, report]));
const submit = async (fake: ReturnType<typeof fakeHost>, attempt: Attempt) => await Effect.runPromise(fake.host.submit(attempt.runId, attempt.compiled.plan, attempt.compiled.docs));
const verdictOf = (attempt: Attempt) => ({ items: Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String })))(attempt.batch).map(({ id }) => ({ id, verdict: true })) });

const Schedules = Arbitrary.all({ cap: int(1, 4), crashes: Arbitrary.array(int(0, 8), { maxLength: 8, minLength: 1 }), depth: int(1, 3), failures: int(0, 5), halt: pick("stuck", "envelope-exceeded"), leaves: int(1, 4) });

const haltSchedule = async ({ cap, crashes, depth, failures, halt, leaves }: typeof Schedules extends Arbitrary.Arbitrary<infer A> ? A : never) => {
  const defined = unwrap(defineComposition(composed(cap, depth), catalog));
  const fake = fakeHost();
  const input = inputOf(leaves);
  const paths = new Map<string, string>();
  const singleLive = () => {
    const live = new Set<string>();
    for (const [id, { report }] of fake.runs) {
      if (terminal.has(report.status)) {continue;}
      const path = paths.get(id);
      if (path === undefined || live.has(path)) {throw new Error("two live attempts for one leaf");}
      live.add(path);
    }
  };
  for (let tick = 0; tick < 80; tick += 1) {
    const state = unwrap(reconcile(defined, { input, runs: reportsOf(fake) }));
    for (const leaf of state.leaves) {for (const attempt of leaf.attempts) {paths.set(attempt.runId, attempt.path);}}
    singleLive();
    if (state.status !== "running" && state.leaves.every(({ status }) => status === "done" || status === "failed")) {
      const expected = failures < cap ? "done" : "failed";
      return state.status === expected && state.submit.length === 0 && state.abort.length === 0 && [...fake.runs.values()].every(({ report }) => terminal.has(report.status)) && fake.calls.submit.length === new Set(fake.calls.submit).size;
    }
    // Crash before some aborts/submits, but every third tick finishes its whole reconciliation.
    const ready = tick % 3 === 2 || (crashes[tick % crashes.length] ?? 0) % 2 === 0;
    if (ready) {
      // Each intent was derived while halted. Simulate Mischief resuming it before abort arrives.
      for (const intent of state.abort) {fake.resume(intent.runId); singleLive();}
      // Ordered ticks and transitions are essential to the safety property.
      // oxlint-disable-next-line no-await-in-loop
      await Effect.runPromise(Effect.forEach(state.abort, (intent) => fake.host.abort(intent.runId, intent.supersededBy, intent.reason), { concurrency: 4 }));
      singleLive();
      // oxlint-disable-next-line no-await-in-loop
      await Promise.all(state.submit.map(async (attempt) => { await submit(fake, attempt); singleLive(); }));
    }
    const next = unwrap(reconcile(defined, { input, runs: reportsOf(fake) }));
    for (const leaf of next.leaves) {
      const report = fake.runs.get(leaf.latest.runId)?.report;
      if (leaf.status !== "active" || report === undefined) {continue;}
      if (leaf.latest.attempt <= failures) {fake.patch(leaf.latest.runId, { status: halt });}
      else {fake.patch(leaf.latest.runId, { docs: { ...report.docs, [leaf.latest.compiled.frozen.writes]: verdictOf(leaf.latest) }, status: "done", value: "done" });}
      singleLive();
    }
  }
  throw new Error("halt schedule did not converge");
};

describe("resumable halt supersession", () => {
  it("generated resume/crash/abort schedules keep at most one live attempt per leaf and converge", async () => {
    expect(await forAll(Schedules, haltSchedule, 100)).toBeUndefined();
  }, 120_000);

  it.each(["running", "paused", "waiting-for-reply", "waiting-for-joel", "waiting-for-provider"] as const)("%s is active, never a failed attempt or an abort target", async (status) => {
    const defined = unwrap(defineComposition(composed(2), catalog));
    const fake = fakeHost();
    const input = inputOf(1);
    const [first] = unwrap(reconcile(defined, { input, runs: {} })).submit;
    if (first === undefined) {throw new Error("no first attempt");}
    await submit(fake, first);
    fake.patch(first.runId, { status });
    expect(unwrap(reconcile(defined, { input, runs: reportsOf(fake) }))).toMatchObject({ abort: [], leaves: [{ status: "active" }], submit: [] });
  });

  it.each(["failed", "aborted", "amendment-refused"] as const)("terminal %s retries without aborting", async (status) => {
    const defined = unwrap(defineComposition(composed(2), catalog));
    const fake = fakeHost();
    const input = inputOf(1);
    const [first] = unwrap(reconcile(defined, { input, runs: {} })).submit;
    if (first === undefined) {throw new Error("no first attempt");}
    await submit(fake, first);
    fake.patch(first.runId, { status });
    const next = unwrap(reconcile(defined, { input, runs: reportsOf(fake) }));
    expect(next.abort).toEqual([]);
    expect(next.submit.map(({ attempt }) => attempt)).toEqual([2]);
    fake.resume(first.runId);
    expect(fake.runs.get(first.runId)?.report.status).toBe(status);
    const unchanged = await Effect.runPromise(fake.host.abort(first.runId, "unused", "idempotent"));
    expect(unchanged.status).toBe(status);
  });

  it("writes abort intent before aborting and submits the replacement only on the next call", async () => {
    const fake = fakeHost();
    const memory = memoryFiles();
    const tools = toolsWith({ ...fake.host, abort: (runId, supersededBy, reason) => {
      expect([...memory.store.values()].some((text) => text.includes(`"supersededBy":"${supersededBy ?? ""}"`))).toBe(true);
      // Resume after inspect, before abort: abort must still make the old run terminal.
      fake.resume(runId);
      return fake.host.abort(runId, supersededBy, reason);
    } }, memory.files);
    const made = await run(tools.workflow_define({ workflow: composed(2) }));
    const { path } = Schema.decodeUnknownSync(Schema.Struct({ path: Schema.String }))(made.data);
    const call = { brief: "review", docs: { batches: JSON.stringify(inputOf(1).batches) }, workflow: path };
    await run(tools.workflow_run(call));
    const [a1] = fake.calls.submit;
    if (a1 === undefined) {throw new Error("no a1");}
    fake.patch(a1, { status: "stuck" });
    const halted = await run(tools.workflow_run(call));
    expect(halted.isError).toBe(false);
    expect(fake.calls.abort).toHaveLength(1);
    expect(fake.calls.abort[0]?.supersededBy).toBe(a1.replace(/-a1$/u, "-a2"));
    expect(fake.calls.submit).toEqual([a1]);
    await run(tools.workflow_run(call));
    expect(fake.calls.submit).toEqual([a1, a1.replace(/-a1$/u, "-a2")]);
    expect(fake.runs.get(a1)?.report.status).toBe("aborted");
  });

  it("at the cap, aborts the resumable halt without naming a nonexistent replacement", async () => {
    const defined = unwrap(defineComposition(composed(1), catalog));
    const fake = fakeHost();
    const input = inputOf(1);
    const [first] = unwrap(reconcile(defined, { input, runs: {} })).submit;
    if (first === undefined) {throw new Error("no attempt");}
    await submit(fake, first);
    fake.patch(first.runId, { status: "envelope-exceeded" });
    const state = unwrap(reconcile(defined, { input, runs: reportsOf(fake) }));
    expect(state).toMatchObject({ abort: [{ runId: first.runId, supersededBy: undefined }], status: "running", submit: [] });
    await Effect.runPromise(fake.host.abort(first.runId, undefined, "cap reached"));
    expect(unwrap(reconcile(defined, { input, runs: reportsOf(fake) }))).toMatchObject({ abort: [], status: "failed", submit: [] });
  });
});
