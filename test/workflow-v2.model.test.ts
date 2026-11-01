// Generated per-leaf host histories for a composed map + gather, against a reference model of each
// leaf's attempt lifecycle: missing -> active -> done | retry | aborting -> retry/failed at the cap.
// The real reconcile runs over the in-memory host after every command; the model predicts each
// leaf's status and attempt, the submit and abort intents, the overall status and the gather totals.
import { Effect, Schema } from "effect";
import { forEach } from "effect/Effect";
import * as Arbitrary from "effect/Arbitrary";
import { describe, expect, it } from "vitest";

import { Prompt } from "../src/compile.ts";
import { defineComposition, reconcile } from "../src/workflow-v2.ts";
import type { DefinedComposition, Reconciled } from "../src/workflow-v2.ts";
import { firstOf, replay, same } from "./command-model.ts";
import { DESK, catalog, fakeHost, forAll } from "./support.ts";

const unwrap = <A>(value: A | Prompt): A => {
  if (value instanceof Prompt) {throw new TypeError(value.message);}
  return value;
};
const definitionOf = (cap: number) => unwrap(defineComposition({
  desk: DESK, id: "model", retryCap: cap, schema: "peons.workflow.v2", steps: [
    { id: "judge", kind: "map", over: { from: "input.batches" }, task: { input: { docs: { batch: { from: "batch" } }, text: "Return batch verdicts" }, kind: "peon", workType: "work" } },
    { from: "judge", id: "collect", kind: "gather", writes: "verdicts" },
  ], version: 1,
}, catalog));
const terminal = new Set(["done", "amendment-refused", "aborted", "failed"]);

const outcomes = ["running", "paused", "done", "omit", "rejected", "failed", "aborted", "amendment-refused", "stuck", "envelope-exceeded"] as const;
type Outcome = (typeof outcomes)[number];
type Command =
  // Run the first `upto` abort intents, then the first `upto` submit intents; fewer than all is a crash.
  | { readonly op: "tick"; readonly upto: number }
  // The host reports an outcome for one leaf's latest attempt (by index modulo the leaf count).
  | { readonly op: "report"; readonly leaf: number; readonly outcome: Outcome; readonly input: number }
  // Mischief resumes a halted run before the abort lands.
  | { readonly op: "resume"; readonly leaf: number };
const between = (minimum: number, maximum: number) => Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum, minimum })));
// Weighted so that generated histories regularly finish: ticks and done reports are common.
const weighted: readonly Outcome[] = ["done", "done", "done", "done", "running", "paused", "omit", "rejected", "failed", "aborted", "amendment-refused", "stuck", "envelope-exceeded", "stuck"];
const CommandArb = Arbitrary.map(Arbitrary.all({ input: between(0, 1000), kind: between(0, 9), leaf: between(0, 3), outcome: between(0, weighted.length - 1), upto: between(0, 4) }), ({ input, kind, leaf, outcome, upto }): Command => {
  if (kind < 4) {return { op: "tick", upto };}
  if (kind < 9) {return { input, leaf, op: "report", outcome: weighted[outcome] ?? "done" };}
  return { leaf, op: "resume" };
});
const Case = Arbitrary.all({
  batches: Arbitrary.array(Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum: 2, minimum: 1 }))), { maxLength: 3, minLength: 1 }),
  cap: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 }))),
  commands: Arbitrary.array(CommandArb, { maxLength: 40, minLength: 1 }),
});
interface Case { readonly batches: readonly number[]; readonly cap: number; readonly commands: readonly Command[] }

type ModelStatus = "missing" | "active" | "aborting" | "done" | "failed";
interface ModelLeaf { attempt: number; status: ModelStatus; costs: (number | null)[]; items: number }

const Gathered = Schema.Struct({ items: Schema.Array(Schema.Struct({ id: Schema.String, leaf: Schema.String })), leaves: Schema.Array(Schema.Struct({ attempts: Schema.Array(Schema.Unknown), costUsd: Schema.NullOr(Schema.Finite) })), totalCostUsd: Schema.NullOr(Schema.Finite) });

// Sums in order, as gather does; one unknown cost makes the sum unknown.
const sumOrNull = (values: readonly (number | null | undefined)[]): number | null => {
  let total: number | null = 0;
  for (const value of values) {total = total === null || value === null || value === undefined ? null : total + value;}
  return total;
};
const overallOf = (leaves: readonly ModelLeaf[]): Reconciled["status"] => {
  if (leaves.some(({ status }) => status === "failed")) {return "failed";}
  return leaves.every(({ status }) => status === "done") ? "done" : "running";
};

// What generated runs reached, so a narrowed generator cannot pass vacuously.
const seen = new Set<string>();

const holds = async ({ batches, cap, commands }: Case, report?: (why: string) => void) => {
  const defined: DefinedComposition = definitionOf(cap);
  const fake = fakeHost();
  const input = { batches: batches.map((size, leaf) => Array.from({ length: size }, (_, item) => ({ id: `l${leaf}i${item}` }))) };
  const model: ModelLeaf[] = batches.map((items) => ({ attempt: 1, costs: [], items, status: "missing" }));
  const prefixes = new Map<number, string>();
  const state = () => unwrap(reconcile(defined, { input, runs: Object.fromEntries([...fake.runs].map(([id, { report: run }]) => [id, run])) }));
  const retry = (leaf: ModelLeaf) => {
    if (leaf.attempt < cap) {Object.assign(leaf, { attempt: leaf.attempt + 1, status: "missing" });}
    else {leaf.status = "failed";}
  };

  const apply = async (command: Command, before: Reconciled) => {
    if (command.op === "tick") {
      const aborts = before.abort.slice(0, command.upto);
      const submits = before.submit.slice(0, command.upto);
      await Effect.runPromise(forEach(aborts, (intent) => fake.host.abort(intent.runId, intent.supersededBy, intent.reason)));
      await Effect.runPromise(forEach(submits, (attempt) => fake.host.submit(attempt.runId, attempt.compiled.plan, attempt.compiled.docs)));
      // Intents come out in leaf order, so the model takes the same prefix of its own leaves.
      // Both prefixes come from the state observed before the tick: an aborted leaf's next attempt waits for the next tick.
      const aborted = model.filter(({ status }) => status === "aborting").slice(0, command.upto);
      const submitted = model.filter(({ status }) => status === "missing").slice(0, command.upto);
      for (const leaf of aborted) {retry(leaf);}
      for (const leaf of submitted) {leaf.status = "active";}
      return;
    }
    const leaf = model[command.leaf % model.length];
    const real = before.leaves[command.leaf % model.length];
    if (leaf === undefined || real === undefined) {return;}
    const { runId } = real.latest;
    if (command.op === "resume") {
      fake.resume(runId);
      if (leaf.status === "aborting") {leaf.status = "active";}
      return;
    }
    if (leaf.status !== "active") {return;}
    const run = fake.runs.get(runId)?.report;
    if (run === undefined) {return;}
    const items = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String })))(real.latest.batch).map(({ id }) => ({ id, verdict: true }));
    const status = ({ done: "done", omit: "done", rejected: "done" } as Partial<Record<Outcome, string>>)[command.outcome] ?? command.outcome;
    fake.patch(runId, {
      docs: { ...run.docs, [real.latest.compiled.frozen.writes]: { items: command.outcome === "omit" ? items.slice(1) : items } },
      status: Schema.decodeUnknownSync(Schema.Literals(["running", "paused", "done", "failed", "aborted", "amendment-refused", "stuck", "envelope-exceeded"]))(status),
      thinking: { line: `sol · ${command.input} tok · ${status}`, tokens: { cacheRead: 0, cacheWrite: 0, input: command.input, output: 0 } },
      value: command.outcome === "rejected" ? "rejected" : "done",
    });
    // gpt-6.1-sol lists input at $2 per million tokens.
    leaf.costs[leaf.attempt - 1] = (command.input * 2) / 1_000_000;
    if (command.outcome === "done") {leaf.status = "done";}
    else if (command.outcome === "stuck" || command.outcome === "envelope-exceeded") {leaf.status = "aborting";}
    else if (command.outcome !== "running" && command.outcome !== "paused") {retry(leaf);}
  };

  const compare = (after: Reconciled): string | undefined => {
    const ids = after.leaves.flatMap(({ attempts }) => attempts.map(({ runId }) => runId));
    const live = after.leaves.map((leaf) => leaf.attempts.filter(({ runId }) => { const run = fake.runs.get(runId); return run !== undefined && !terminal.has(run.report.status); }).length);
    const status = overallOf(model);
    seen.add(`workflow ${status}`);
    for (const leaf of model) {seen.add(`leaf ${leaf.status}${leaf.attempt > 1 ? " retried" : ""}`);}
    const checks = after.leaves.map((leaf, index) => {
      const expected = model[index];
      if (expected === undefined) {return "a leaf the model does not have";}
      const prefix = prefixes.get(index) ?? leaf.attempts[0]?.runId.replace(/-a1$/u, "") ?? "";
      prefixes.set(index, prefix);
      return firstOf(
        same(`leaf ${index} status`, leaf.status, expected.status),
        same(`leaf ${index} attempt`, leaf.latest.attempt, expected.attempt),
        same(`leaf ${index} attempt ids`, leaf.attempts.map(({ runId }) => runId), Array.from({ length: expected.attempt }, (_, at) => `${prefix}-a${at + 1}`)),
      );
    });
    const abort = model.flatMap((leaf, index) => leaf.status === "aborting" ? [{ runId: `${prefixes.get(index) ?? ""}-a${leaf.attempt}`, supersededBy: leaf.attempt < cap ? `${prefixes.get(index) ?? ""}-a${leaf.attempt + 1}` : undefined }] : []);
    const gathered = after.docs["collect.verdicts"];
    let totals: string | undefined;
    if (status === "done") {
      const doc = Schema.decodeUnknownSync(Gathered)(gathered);
      const leafCosts = model.map(({ attempt, costs }) => sumOrNull(costs.slice(0, attempt)));
      totals = firstOf(
        same("gathered items", doc.items.length, sumOrNull(model.map(({ items }) => items))),
        same("leaf costs", doc.leaves.map(({ costUsd }) => costUsd), leafCosts),
        same("leaf attempts", doc.leaves.map(({ attempts }) => attempts.length), model.map(({ attempt }) => attempt)),
        same("total cost", doc.totalCostUsd, sumOrNull(leafCosts)),
      );
    } else if (gathered !== undefined) {totals = "gathered before every leaf was done";}
    return firstOf(
      ...checks,
      same("leaf count", after.leaves.length, model.length),
      new Set(ids).size === ids.length ? undefined : `attempt ids repeat: ${ids.join(", ")}`,
      live.some((count) => count > 1) ? `a leaf has ${Math.max(...live)} live attempts` : undefined,
      same("submit intents", after.submit.map(({ path, attempt }) => `${path}#${attempt}`), model.flatMap((leaf, index) => leaf.status === "missing" ? [`judge/map[${index}]#${leaf.attempt}`] : [])),
      same("abort intents", after.abort.map(({ runId, supersededBy }) => ({ runId, supersededBy })), abort),
      same("status", after.status, status),
      totals,
    );
  };

  const initial = compare(state());
  if (initial !== undefined) {report?.(`initial: ${initial}`); return false;}
  return await replay(commands, async (command) => {
    await apply(command, state());
    return compare(state());
  }, report);
};

describe("workflow v2 command model", () => {
  it("generated per-leaf report/resume/tick histories match the attempt model after every step", async () => {
    let why = "";
    const failure = await forAll(Case, async (value) => await holds(value, (mismatch) => { why = mismatch; }), 200, 40);
    expect(failure === undefined ? undefined : `${failure}\n${why}`).toBeUndefined();
    expect([...seen].toSorted()).toEqual(expect.arrayContaining(["leaf aborting", "leaf aborting retried", "leaf done retried", "leaf failed", "leaf failed retried", "leaf missing retried", "workflow done", "workflow failed", "workflow running"]));
  }, 30_000);

  it("a hand-picked history: halt, resume, halt, partial tick, abort, retry, omit, then gather", async () => {
    const commands: Command[] = [
      { op: "tick", upto: 4 },
      { input: 100, leaf: 0, op: "report", outcome: "stuck" },
      { leaf: 0, op: "resume" },
      { input: 120, leaf: 0, op: "report", outcome: "envelope-exceeded" },
      { op: "tick", upto: 0 },
      { op: "tick", upto: 4 },
      { op: "tick", upto: 4 },
      { input: 200, leaf: 0, op: "report", outcome: "omit" },
      { input: 300, leaf: 1, op: "report", outcome: "done" },
      { op: "tick", upto: 4 },
      { input: 400, leaf: 0, op: "report", outcome: "done" },
    ];
    let why = "";
    const held = await holds({ batches: [2, 1], cap: 3, commands }, (mismatch) => { why = mismatch; });
    expect(why).toBe("");
    expect(held).toBe(true);
  });

  it("a hand-picked history: a superseded attempt, then a failure at the cap, fails the workflow", async () => {
    const commands: Command[] = [
      { op: "tick", upto: 4 },
      { input: 10, leaf: 0, op: "report", outcome: "stuck" },
      { op: "tick", upto: 4 },
      { op: "tick", upto: 4 },
      { input: 20, leaf: 1, op: "report", outcome: "done" },
      { input: 30, leaf: 0, op: "report", outcome: "failed" },
      { op: "tick", upto: 4 },
    ];
    let why = "";
    const held = await holds({ batches: [1, 2], cap: 2, commands }, (mismatch) => { why = mismatch; });
    expect(why).toBe("");
    expect(held).toBe(true);
  });
});
