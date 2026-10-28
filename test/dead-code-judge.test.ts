import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { Prompt, compileRun } from "../src/compile.ts";
import { PeonRefused } from "../src/contract.ts";
import { decodeVerdict, fromRunReport } from "../src/run-report.ts";
import { compile, loadTemplate } from "../src/think-template.ts";
import { quotesOf, verifyQuotes } from "../src/verdicts.ts";
import { defineComposition, gather, reconcile } from "../src/workflow-v2.ts";
import { DESK, catalog, fakeHost } from "./support.ts";

const template = loadTemplate(new URL("../templates/dead-code-judge/v1", import.meta.url).pathname);
const batch = [{ id: "src/a.ts#used" }, { id: "scripts/a.ts#unused" }];
const evidence = "src/a.ts#used: called by skills/check.md\nscripts/a.ts#unused: no callers; dynamic loads checked";
const docs = { batch: JSON.stringify(batch), evidence };
const verdict = { items: batch.map(({ id }) => ({ confidence: "high", id, proof: [{ quote: evidence, source: "evidence" }], testFilesCoveringOnlyIt: [], verdict: "live" })), schema: "peons.verdict.dead-code.v1" };
const request = { base: null, desk: DESK, input: { docs, kind: "brief" as const, text: "Judge these ids" }, runId: "dead-code", schema: "peons.request.v1" as const, scope: [], target: { kind: "template" as const, template: "dead-code-judge", version: 1 } };
const name = "peons.verdict.dead-code.v1";
const unwrap = <A>(value: A | Prompt): A => {if (value instanceof Prompt) {throw new TypeError(value.message);} return value;};

describe("dead-code-judge@1", () => {
  it("loads pinned files and compiles bounded required inputs with optional desk rules", () => {
    expect(template.spec).toMatchObject({ kind: "judge", owner: "agent-graph/desk", profile: { model: "opus", thinking: "medium" } });
    const compiled = compile(template, request);
    expect(Schema.is(PeonRefused)(compiled)).toBe(false);
    for (const [doc, maxBytes] of [["batch", 40_000], ["evidence", 60_000], ["rules", 8000]] as const) {
      const tooLarge = compile(template, { ...request, input: { ...request.input, docs: { ...docs, [doc]: "é".repeat(maxBytes / 2 + 1) } } });
      expect(tooLarge).toMatchObject({ tag: "InputTooLarge" });
      const atLimit = compile(template, { ...request, input: { ...request.input, docs: { ...docs, [doc]: "x".repeat(maxBytes) } } });
      expect(Schema.is(PeonRefused)(atLimit)).toBe(false);
    }
    expect(compile(template, { ...request, input: { ...request.input, docs: { evidence } } })).toMatchObject({ tag: "MissingInput" });
    expect(compile(template, { ...request, input: { ...request.input, docs: { batch: docs.batch } } })).toMatchObject({ tag: "MissingInput" });
  });

  it("decodes all normal verdicts and checks quotes byte-for-byte against evidence only", () => {
    for (const label of ["dead", "live", "drop-export", "unsure"]) {
      expect(decodeVerdict(name, { ...verdict, items: verdict.items.map((item) => ({ ...item, verdict: label })) }, docs).ok).toBe(true);
    }
    const decoded = decodeVerdict(name, verdict, docs);
    if (!decoded.ok) {throw new Error(decoded.why);}
    expect(quotesOf(decoded.verdict)).toHaveLength(2);
    expect(verifyQuotes(decoded.verdict, docs)).toEqual([]);
    expect(verifyQuotes(decoded.verdict, { evidence: evidence.toUpperCase() })).toHaveLength(2);
    expect(decodeVerdict(name, verdict, { ...docs, evidence: "invented quote" }).ok).toBe(false);
    expect(decodeVerdict(name, { ...verdict, items: verdict.items.map((item) => ({ ...item, proof: [{ quote: docs.batch, source: "batch" }] })) }, docs).ok).toBe(false);
  });

  it("refuses missing, duplicate, foreign, malformed ids and missing proof in its own leaf", async () => {
    const compiled = unwrap(compileRun(request, null, template));
    const host = fakeHost();
    await Effect.runPromise(host.host.submit(compiled.runId, compiled.plan, compiled.docs));
    const report = host.runs.get(compiled.runId)?.report;
    if (report === undefined) {throw new Error("missing report");}
    const badItems = [[], [verdict.items[0], verdict.items[0]], [{ ...verdict.items[0], id: "other.ts#foreign" }, verdict.items[1]], [{ ...verdict.items[0], id: "not-an-id" }, verdict.items[1]], [{ ...verdict.items[0], proof: [] }, verdict.items[1]]];
    for (const items of badItems) {
      const observed = { ...report, docs: { ...report.docs, [compiled.frozen.writes]: JSON.stringify({ ...verdict, items }) }, status: "done" as const, value: "done" };
      expect(fromRunReport(observed, request)).toMatchObject({ tag: "VerdictInvalid", type: "peon.failed" });
    }
    expect(fromRunReport({ ...report, docs: { ...report.docs, [compiled.frozen.writes]: verdict }, status: "done", value: "done" }, request)).toMatchObject({ type: "peon.done" });
  });

  it("retries fabricated quotes and gathers full proof/confidence/test-file fields after a valid retry", async () => {
    const deps = { ...catalog, think: [...catalog.think, template] };
    const defined = unwrap(defineComposition({ desk: DESK, id: "dead-code", schema: "peons.workflow.v2", steps: [
      { id: "judge", kind: "map", over: { from: "input.batches" }, task: { input: { docs: { batch: { from: "batch" }, evidence: { from: "input.evidence" } }, text: "Judge batch" }, kind: "peon", template: "dead-code-judge@1" } },
      { from: "judge", id: "gather", kind: "gather", writes: "verdicts" },
    ], version: 1 }, deps));
    const fake = fakeHost();
    const input = { batches: [batch], evidence };
    const state = () => unwrap(reconcile(defined, { input, runs: Object.fromEntries([...fake.runs].map(([id, entry]) => [id, entry.report])) }));
    for (const attemptNumber of [1, 2]) {
      const [attempt] = state().submit;
      if (attempt === undefined) {throw new Error("missing attempt");}
      expect(attempt.attempt).toBe(attemptNumber);
      // The host here is strictly fake; no live submit is allowed by the brief.
      // oxlint-disable-next-line no-await-in-loop
      await Effect.runPromise(fake.host.submit(attempt.runId, attempt.compiled.plan, attempt.compiled.docs));
      const report = fake.runs.get(attempt.runId)?.report;
      if (report === undefined) {throw new Error("missing report");}
      fake.patch(attempt.runId, { docs: { ...report.docs, [attempt.compiled.frozen.writes]: verdict, evidence: attemptNumber === 1 ? "not the quoted evidence" : evidence }, status: "done", value: "done" });
    }
    const settled = state();
    expect(settled.status).toBe("done");
    const gathered = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Schema.Json) }))(settled.docs["gather.verdicts"]);
    expect(gathered.items).toEqual(verdict.items.map((item) => ({ ...item, leaf: "judge/map[0]" })));
    const forged = settled.leaves.map((leaf) => leaf.report === undefined ? leaf : { ...leaf, report: { ...leaf.report, docs: { ...leaf.report.docs, evidence: "missing the exact quote" } } });
    expect(gather(forged)).toBeInstanceOf(Prompt);
  });
});
