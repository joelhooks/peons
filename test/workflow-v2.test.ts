import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { describe, expect, it } from "vitest";

import { FROZEN_DOC, INPUT_DOC, Prompt, canonical } from "../src/compile.ts";
import { defineWorkflow } from "../src/workflow.ts";
import { attemptId, decodeComposition, defineComposition, gather, reconcile } from "../src/workflow-v2.ts";
import type { Attempt, DefinedComposition, Reconciled } from "../src/workflow-v2.ts";
import { DESK, catalog, fakeHost, forAll, int, memoryFiles, run, toolsWith } from "./support.ts";

const unwrap = <A>(value: A | Prompt): A => {
  if (value instanceof Prompt) {throw new TypeError(value.message);}
  return value;
};
const nested = (count = 2, gate = "verify") => unwrap(defineWorkflow({
  desk: DESK, id: "nested", schema: "peons.workflow.v1",
  steps: Array.from({ length: count }, (_, index) => ({ check: "has evidence", gate, id: `step${index}`, input: { from: [index === 0 ? "input" : `step${index - 1}`], text: "Review the batch and return {items:[{id,verdict}]}" }, kind: "peon", workType: "scan" })),
  version: 1,
}, catalog));
const peon = (docs: Record<string, { from: string }> = {}) => ({ input: { docs, text: "Return JSON" }, kind: "peon", workType: "scan" });
const workflow = (count: number, docs: Record<string, { from: string }>) => ({ input: { docs, text: "Review" }, kind: "workflow", workflow: nested(count) });
const rawDefinition = (cap = 2, count = 2, maps = 1) => ({
  desk: DESK, id: "composed", retryCap: cap, schema: "peons.workflow.v2", steps: [
    { id: "slice", ...peon({ batches: { from: "input.batches" } }) },
    ...Array.from({ length: maps }, (_, index) => [
      { id: `judge${index}`, kind: "map", over: { from: "slice.artifact" }, task: workflow(count, { batch: { from: "batch" } }) },
      { from: `judge${index}`, id: `gather${index}`, kind: "gather", writes: "verdicts" },
    ]).flat(),
    { id: "reprove", ...workflow(count, { verdicts: { from: `gather${maps - 1}.verdicts` } }) },
  ], version: 1,
});
const definition = (cap = 2, count = 2, maps = 1) => unwrap(defineComposition(rawDefinition(cap, count, maps), catalog));
const batchesOf = (count = 2, revision = 0) => Array.from({ length: count }, (_, index) => [{ id: `item${index}`, revision }]);
const observed = (fake: ReturnType<typeof fakeHost>, batches: Schema.Json) => ({ input: { batches }, runs: Object.fromEntries([...fake.runs].map(([id, { report }]) => [id, report])) });
const stateOf = (defined: DefinedComposition, fake: ReturnType<typeof fakeHost>, batches: Schema.Json) => unwrap(reconcile(defined, observed(fake, batches)));
const verdictOf = (attempt: Attempt, batches: Schema.Json): Schema.Json => {
  if (attempt.path === "slice") {return batches;}
  if (attempt.batch === null) {return { ok: true };}
  const items = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String, revision: Schema.Int })))(attempt.batch);
  return { items: items.map(({ id, revision }) => ({ id, verdict: revision })) };
};
const submit = async (fake: ReturnType<typeof fakeHost>, attempt: Attempt) => await Effect.runPromise(fake.host.submit(attempt.runId, attempt.compiled.plan, attempt.compiled.docs));

// The scheduler deliberately forgets its local variables between ticks. The host's run records are
// the only durable progress. Skipping a prefix models a caller crashing before/after a submission.
const drive = async (defined: DefinedComposition, fake: ReturnType<typeof fakeHost>, batches: Schema.Json, failures: number, crashes: readonly number[], fault: "host" | "omission" = "host"): Promise<Reconciled> => {
  for (let tick = 0; tick < 90; tick += 1) {
    const state = stateOf(defined, fake, batches);
    if (state.status !== "running" && state.leaves.every(({ status }) => status === "done" || status === "failed")) {return state;}
    const prefix = tick % 3 === 2 ? state.submit.length : (crashes[tick % crashes.length] ?? 0) % (state.submit.length + 1);
    // Each tick observes the preceding tick; running ticks concurrently would erase the crash model.
    // oxlint-disable-next-line no-await-in-loop
    await Promise.all(state.submit.slice(0, prefix).map(async (attempt) => await submit(fake, attempt)));
    const afterCrash = stateOf(defined, fake, batches);
    // Another reconcile immediately after a crash cannot ask for an already submitted attempt.
    if (afterCrash.submit.some(({ runId }) => fake.runs.has(runId))) {throw new Error("duplicate attempt");}
    if (tick % 2 === 0) {continue;}
    for (const leaf of afterCrash.leaves) {
      if (leaf.status !== "active") {continue;}
      const attempt = leaf.latest;
      const report = fake.runs.get(attempt.runId)?.report;
      if (report === undefined) {throw new Error("active leaf missing on host");}
      const fails = attempt.attempt <= failures;
      let verdict = verdictOf(attempt, batches);
      if (fault === "omission" && fails && attempt.batch !== null) {
        const { items } = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Schema.Json) }))(verdict);
        verdict = { items: items.slice(1) };
      }
      const hostFailed = fault === "host" && fails;
      fake.patch(attempt.runId, { docs: { ...report.docs, [attempt.compiled.frozen.writes]: verdict }, listCostUsd: 0.1, status: hostFailed ? "failed" : "done", thinking: { line: "fixture", tokens: { cacheRead: 1, input: 2, output: 3 } }, value: hostFailed ? "work" : "done" });
    }
  }
  throw new Error("did not converge");
};

const Schedule = Arbitrary.all({ cap: int(1, 4), crashes: Arbitrary.array(int(0, 8), { maxLength: 8, minLength: 1 }), failures: int(0, 5), leaves: int(1, 4), maps: int(1, 2), nestedSteps: int(1, 3) });

describe("composed workflow reconcile", () => {
  it("generated nested workflows × crash/retry schedules converge without duplicate attempts, and changed input never reuses a verdict", async () => {
    expect(await forAll(Schedule, async ({ cap, crashes, failures, leaves, maps, nestedSteps }) => {
      const defined = definition(cap, nestedSteps, maps);
      const fake = fakeHost();
      const first = await drive(defined, fake, batchesOf(leaves), failures, crashes);
      const expected = failures < cap ? "done" : "failed";
      if (first.status !== expected || first.submit.length !== 0) {return false;}
      if (first.leaves.some(({ latest }) => latest.attempt > cap)) {return false;}
      for (let tick = 0; tick < 3; tick += 1) {
        const again = stateOf(defined, fake, batchesOf(leaves));
        if (again.status !== expected || again.submit.length !== 0) {return false;}
      }
      const oldIds = new Set(fake.calls.submit);
      const changed = stateOf(defined, fake, batchesOf(leaves, 1));
      if (changed.status !== "running" || changed.submit.length === 0 || changed.submit.some(({ runId }) => oldIds.has(runId))) {return false;}
      const second = await drive(defined, fake, batchesOf(leaves, 1), failures, crashes);
      if (second.status !== expected) {return false;}
      if (expected === "done") {
        const gathered = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Schema.Struct({ verdict: Schema.Int })) }))(second.docs["gather0.verdicts"]);
        if (gathered.items.length !== leaves || gathered.items.some(({ verdict }) => verdict !== 1)) {return false;}
      }
      return fake.calls.submit.length === new Set(fake.calls.submit).size;
    }, 100)).toBeUndefined();
  }, 120_000);

  it("generated omitted-item verdict schedules retry done map attempts and converge or fail at the cap without refusing", async () => {
    expect(await forAll(Schedule, async ({ cap, crashes, failures, leaves, maps, nestedSteps }) => {
      const defined = definition(cap, nestedSteps, maps);
      const fake = fakeHost();
      const batches = batchesOf(leaves);
      const settled = await drive(defined, fake, batches, failures, crashes, "omission");
      const expected = failures < cap ? "done" : "failed";
      if (settled.status !== expected || settled.submit.length !== 0) {return false;}
      const mapLeaves = settled.leaves.filter(({ latest }) => latest.batch !== null);
      if (mapLeaves.length !== leaves * maps) {return false;}
      if (mapLeaves.some(({ latest, status }) => latest.attempt !== Math.min(failures + 1, cap) || status !== expected)) {return false;}
      const again = stateOf(defined, fake, batches);
      return again.status === expected && again.submit.length === 0 && fake.calls.submit.length === new Set(fake.calls.submit).size;
    }, 100)).toBeUndefined();
  }, 120_000);

  it("generated mixed per-leaf schedules exhaust map leaves at the cap without looping", async () => {
    const mixed = Arbitrary.all({ cap: int(1, 4), crashes: Arbitrary.array(int(0, 9), { maxLength: 6, minLength: 1 }), failures: Arbitrary.array(int(0, 5), { maxLength: 5, minLength: 1 }), nestedSteps: int(1, 3) });
    expect(await forAll(mixed, async ({ cap, crashes, failures, nestedSteps }) => {
      const raw = { ...rawDefinition(cap), steps: [
        { id: "judge", kind: "map", over: { from: "input.batches" }, task: workflow(nestedSteps, { batch: { from: "batch" } }) },
        { from: "judge", id: "collect", kind: "gather", writes: "verdicts" },
      ] };
      const defined = unwrap(defineComposition(raw, catalog));
      const fake = fakeHost();
      const batches = batchesOf(failures.length);
      for (let tick = 0; tick < cap * 4 + 4; tick += 1) {
        const state = stateOf(defined, fake, batches);
        const prefix = tick % 2 === 1 ? state.submit.length : (crashes[tick % crashes.length] ?? 0) % (state.submit.length + 1);
        // Ordered ticks model crashes; only the submissions within a tick run concurrently.
        // oxlint-disable-next-line no-await-in-loop
        await Promise.all(state.submit.slice(0, prefix).map(async (attempt) => await submit(fake, attempt)));
        const next = stateOf(defined, fake, batches);
        for (const [index, leaf] of next.leaves.entries()) {
          if (leaf.status !== "active" || leaf.report === undefined) {continue;}
          const attempt = leaf.latest;
          const fails = attempt.attempt <= (failures[index] ?? 0);
          fake.patch(attempt.runId, { docs: { ...leaf.report.docs, [attempt.compiled.frozen.writes]: verdictOf(attempt, batches) }, status: fails ? "failed" : "done", value: "done" });
        }
      }
      const final = stateOf(defined, fake, batches);
      if (final.submit.length !== 0 || final.leaves.length !== failures.length) {return false;}
      for (const [index, leaf] of final.leaves.entries()) {
        const count = failures[index] ?? 0;
        if (leaf.status !== (count < cap ? "done" : "failed") || leaf.latest.attempt !== Math.min(count + 1, cap)) {return false;}
      }
      return fake.calls.submit.length === new Set(fake.calls.submit).size;
    }, 100)).toBeUndefined();
  }, 120_000);

  it("a1 absent, a2 after failure, then terminal failure at the default cap", async () => {
    const { retryCap: _cap, ...withoutCap } = rawDefinition();
    const defined = unwrap(defineComposition(withoutCap, catalog));
    const fake = fakeHost();
    const [first] = stateOf(defined, fake, batchesOf()).submit;
    expect(first?.runId).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/u);
    if (first === undefined) {throw new Error("missing a1");}
    await submit(fake, first);
    expect(stateOf(defined, fake, batchesOf()).submit).toEqual([]);
    fake.patch(first.runId, { status: "failed" });
    const [second] = stateOf(defined, fake, batchesOf()).submit;
    expect(second?.runId).toBe(first.runId.replace(/-a1$/u, "-a2"));
    if (second === undefined) {throw new Error("missing a2");}
    await submit(fake, second);
    fake.patch(second.runId, { status: "failed" });
    expect(stateOf(defined, fake, batchesOf())).toMatchObject({ status: "failed", submit: [] });
  });

  it("run identity binds input digest, nested path, workflow digest and profile", () => {
    const id = attemptId("digest", "map[0]/nested", ["input"], { model: "sol" }, 1, DESK);
    expect(new Set([
      id,
      attemptId("changed", "map[0]/nested", ["input"], { model: "sol" }, 1, DESK),
      attemptId("digest", "map[1]/nested", ["input"], { model: "sol" }, 1, DESK),
      attemptId("digest", "map[0]/nested", ["changed"], { model: "sol" }, 1, DESK),
      attemptId("digest", "map[0]/nested", ["input"], { model: "luna" }, 1, DESK),
    ]).size).toBe(5);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it("does not start downstream work while a nested workflow waits at its Mischief gate", async () => {
    const defined = definition();
    const fake = fakeHost();
    const [slice] = stateOf(defined, fake, batchesOf()).submit;
    if (slice === undefined) {throw new Error("missing slice");}
    await submit(fake, slice);
    fake.patch(slice.runId, { docs: { ...slice.compiled.docs, artifact: batchesOf() }, status: "done", value: "done" });
    const next = stateOf(defined, fake, batchesOf());
    expect(next.submit).toHaveLength(2);
    await Promise.all(next.submit.map(async (attempt) => {
      expect(Object.keys(attempt.compiled.plan.machine.states)).toContain("step0_verify");
      await submit(fake, attempt);
      fake.patch(attempt.runId, { status: "waiting-for-joel" });
    }));
    expect(stateOf(defined, fake, batchesOf())).toMatchObject({ steps: { gather0: "waiting", reprove: "waiting" }, submit: [] });
  });

  it("gathers per-item verdicts and all-attempt costs and tokens; unknown cost is not $0", async () => {
    const defined = definition(3);
    const fake = fakeHost();
    const settled = await drive(defined, fake, batchesOf(), 1, [3]);
    const result = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Schema.Json), leaves: Schema.Array(Schema.Struct({ cost: Schema.Finite, tokens: Schema.Struct({ cacheRead: Schema.Finite, input: Schema.Finite, output: Schema.Finite }) })) }))(settled.docs["gather0.verdicts"]);
    expect(result.items).toHaveLength(2);
    expect(result.leaves).toEqual(Array.from({ length: 2 }, () => ({ cost: 0.2, tokens: { cacheRead: 2, input: 4, output: 6 } })));
    const mapLeaf = settled.leaves.find(({ path }) => path === "judge0/map[0]");
    if (mapLeaf === undefined) {throw new Error("missing map leaf");}
    const old = fake.runs.get(mapLeaf.latest.runId);
    if (old === undefined) {throw new Error("missing report");}
    const { listCostUsd: _cost, thinking: _thinking, ...report } = old.report;
    old.report = report;
    const unknown = stateOf(defined, fake, batchesOf());
    expect(canonical(unknown.docs["gather0.verdicts"])).toContain('"cost":null');
    expect(canonical(unknown.docs["gather0.verdicts"])).toContain('"tokens":null');
  });

  it.each(["missing", "duplicate", "foreign", "malformed"])("retries a %s map verdict while gather retains its final guard", async (fault) => {
    const defined = definition();
    const fake = fakeHost();
    const settled = await drive(defined, fake, batchesOf(), 0, [4]);
    const leaf = settled.leaves.find(({ path }) => path === "judge0/map[0]");
    if (leaf === undefined || leaf.report === undefined) {throw new Error("no leaf");}
    const id = "item0";
    const bad = { duplicate: { items: [{ id, verdict: true }, { id, verdict: true }] }, foreign: { items: [{ id: "foreign", verdict: true }] }, malformed: "not-json", missing: { items: [] } }[fault];
    fake.patch(leaf.latest.runId, { docs: { ...leaf.report.docs, [leaf.latest.compiled.frozen.writes]: bad ?? null } });
    const retry = stateOf(defined, fake, batchesOf());
    expect(retry.status).toBe("running");
    expect(retry.submit).toHaveLength(1);
    expect(retry.submit[0]?.attempt).toBe(2);
    const badReport = fake.runs.get(leaf.latest.runId)?.report;
    expect(gather([{ ...leaf, report: badReport }])).toBeInstanceOf(Prompt);
  });

  it("invalid declared template verdicts retry and fail at the cap instead of chaining stale or malformed output", async () => {
    const raw = { ...rawDefinition(), steps: [{ id: "review", input: { docs: { subject: { from: "input.subject" } }, text: "review" }, kind: "peon", template: "fix-review@1" }] };
    const defined = unwrap(defineComposition(raw, catalog));
    const fake = fakeHost();
    const input = { subject: "proof" };
    const [a1] = unwrap(reconcile(defined, { input, runs: {} })).submit;
    if (a1 === undefined) {throw new Error("missing attempt");}
    await submit(fake, a1);
    fake.patch(a1.runId, { docs: { ...a1.compiled.docs, review: "not a verdict" }, status: "done", value: "done" });
    const reports = () => Object.fromEntries([...fake.runs].map(([id, { report }]) => [id, report]));
    const next = unwrap(reconcile(defined, { input, runs: reports() }));
    expect(next.submit).toHaveLength(1);
    const [a2] = next.submit;
    if (a2 === undefined) {throw new Error("missing retry");}
    expect(a2.attempt).toBe(2);
    expect(a2.compiled.docs.subject).toBe("proof");
    await submit(fake, a2);
    fake.patch(a2.runId, { docs: { ...a2.compiled.docs, review: {} }, status: "done", value: "done" });
    expect(unwrap(reconcile(defined, { input, runs: reports() }))).toMatchObject({ status: "failed", submit: [] });
  });

  it("an empty map gathers no items without submitting", () => {
    const defined = unwrap(defineComposition({ ...rawDefinition(), steps: [
      { id: "judge", kind: "map", over: { from: "input.batches" }, task: peon({ batch: { from: "batch" } }) },
      { from: "judge", id: "collect", kind: "gather", writes: "verdicts" },
    ] }, catalog));
    expect(unwrap(reconcile(defined, { input: { batches: [] }, runs: {} }))).toMatchObject({ docs: { "collect.verdicts": { items: [], leaves: [] } }, status: "done", submit: [] });
  });

  it("pins embedded v1 plans by digest and refuses tampering", () => {
    const defined = definition();
    expect(decodeComposition({ ...defined, digest: "0".repeat(64) })).toBeInstanceOf(Prompt);
    const source = nested();
    expect(defineComposition({ ...rawDefinition(), steps: [{ id: "nested", ...workflow(2, {}), workflow: { ...source, digest: "0".repeat(64) } }] }, catalog)).toBeInstanceOf(Prompt);
  });
});

const dataPath = (out: { data: unknown }) => Schema.decodeUnknownSync(Schema.Struct({ path: Schema.String }))(out.data).path;

describe("workflow_run v2 adapter (fakeHost only)", () => {
  it("writes the definition and manifest before submit, then recovers from a partial submit without duplicates", async () => {
    const fake = fakeHost();
    const memory = memoryFiles();
    let crash = true;
    const tools = toolsWith({ ...fake.host, submit: (id, plan, docs) => Effect.suspend(() => {
      expect([...memory.store.keys()].some((key) => key.includes("workflow-runs/"))).toBe(true);
      if (crash && fake.calls.submit.length === 1) {crash = false; return Effect.die(new Error("caller crashed"));}
      return fake.host.submit(id, plan, docs);
    }) }, memory.files);
    const raw = { ...rawDefinition(), steps: [{ id: "judge", kind: "map", over: { from: "input.batches" }, task: peon({ batch: { from: "batch" } }) }] };
    const made = await run(tools.workflow_define({ workflow: raw }));
    expect(made.isError).toBe(false);
    const path = dataPath(made);
    expect(path).toContain("by-digest/");
    const call = { brief: "go", docs: { batches: JSON.stringify(batchesOf(3)) }, workflow: path };
    await expect(run(tools.workflow_run(call))).rejects.toThrow("caller crashed");
    const resumed = await run(tools.workflow_run(call));
    expect(resumed.isError).toBe(false);
    expect(fake.calls.submit).toHaveLength(3);
    await run(tools.workflow_run(call));
    expect(fake.calls.submit).toHaveLength(3);
    expect(new Set(fake.calls.submit).size).toBe(3);
  });

  it("all-or-none: a later invalid leaf refuses before any submission", async () => {
    const fake = fakeHost();
    const memory = memoryFiles();
    const tools = toolsWith(fake.host, memory.files);
    const raw = { ...rawDefinition(), steps: [
      { id: "first", ...peon() },
      { id: "second", input: { docs: { subject: { from: "input.subject" } }, text: "review" }, kind: "peon", template: "fix-review@1" },
    ] };
    const made = await run(tools.workflow_define({ workflow: raw }));
    expect(made.isError).toBe(false);
    const result = await run(tools.workflow_run({ brief: "go", docs: { subject: "x".repeat(1001) }, workflow: dataPath(made) }));
    expect(result.isError).toBe(true);
    expect(result.text.split("\n")).toHaveLength(4);
    expect(fake.calls.submit).toHaveLength(0);
    expect([...memory.store.keys()].filter((key) => key.includes("workflow-runs/"))).toHaveLength(0);
  });

  it("validates map cardinality, ids, sources and retry caps without live calls", async () => {
    const fake = fakeHost();
    const tools = toolsWith(fake.host);
    await Promise.all([0, 65].map(async (retryCap) => {
      const out = await run(tools.workflow_define({ workflow: { ...rawDefinition(), retryCap } }));
      expect(out.isError).toBe(true);
    }));
    const forward = await run(tools.workflow_define({ workflow: { ...rawDefinition(), steps: [{ id: "bad", ...peon({ one: { from: "later.artifact" } }) }] } }));
    expect(forward.isError).toBe(true);
    const raw = { ...rawDefinition(), steps: [{ id: "judge", kind: "map", over: { from: "input.batches" }, task: peon({ batch: { from: "batch" } }) }] };
    const made = await run(tools.workflow_define({ workflow: raw }));
    await Promise.all([batchesOf(65), [[{ id: "same" }], [{ id: "same" }]], ["not-a-batch"]].map(async (batches) => {
      const out = await run(tools.workflow_run({ brief: "go", docs: { batches: JSON.stringify(batches) }, workflow: dataPath(made) }));
      expect(out.isError).toBe(true);
    }));
    expect(fake.calls.submit).toHaveLength(0);
    const good = await run(tools.workflow_run({ brief: "go", docs: { batches: JSON.stringify(batchesOf(64)) }, workflow: dataPath(made) }));
    expect(good.isError).toBe(false);
    expect(fake.calls.submit).toHaveLength(64);
  });

  it("accepts actual v2 leaf ids for status and gate answers, with desk ownership checked", async () => {
    const fake = fakeHost();
    const tools = toolsWith(fake.host);
    const source = nested(1, "owner-approve");
    const made = await run(tools.workflow_define({ workflow: { ...rawDefinition(), steps: [{ id: "leaf", ...workflow(1, {}), workflow: source }] } }));
    await run(tools.workflow_run({ brief: "go", workflow: dataPath(made) }));
    const [id] = fake.calls.submit;
    if (id === undefined) {throw new Error("missing leaf");}
    fake.patch(id, { awaiting: [{ key: "step0_ask", messageId: "approval", to: DESK, writes: "step0_answer" }], status: "waiting-for-reply" });
    const status = await run(tools.peon_status({ runId: id }));
    expect(status.isError).toBe(false);
    const answer = await run(tools.peon_answer({ answer: "approve", messageId: "approval", runId: id }));
    expect(answer.isError).toBe(false);
    expect(fake.calls.deliver).toEqual([{ body: "approve", replyTo: "approval", runId: id }]);
    const record = fake.runs.get(id);
    if (record === undefined) {throw new Error("missing report");}
    fake.patch(id, { docs: { ...record.report.docs, [FROZEN_DOC]: {} } });
    const foreign = await run(tools.peon_status({ runId: id }));
    expect(foreign.isError).toBe(true);
  });

  it("substitutes named docs without modifying the frozen plan, and keeps v1 workflow gates as states", async () => {
    const fake = fakeHost();
    const tools = toolsWith(fake.host);
    const made = await run(tools.workflow_define({ workflow: { ...rawDefinition(), steps: [{ id: "leaf", ...workflow(2, { evidence: { from: "input.evidence" } }) }] } }));
    await run(tools.workflow_run({ brief: "go", docs: { evidence: "proof" }, workflow: dataPath(made) }));
    const [first] = [...fake.runs.values()];
    expect(first?.report.docs[INPUT_DOC]).toEqual({ docs: { evidence: "proof" }, text: "Review" });
    expect(first?.body).toContain("step0_verify");
    expect(first?.report.docs[FROZEN_DOC]).toBeDefined();
    expect(fake.calls.submit).toHaveLength(1);
  });
});
