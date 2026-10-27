import { Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { describe, expect, it } from "vitest";

import { PeonRecord, PeonRequest, PeonRunResult as RunResult } from "../src/contract.ts";
import { Prompt, compileRun, sha256 } from "../src/compile.ts";
import type { Compiled } from "../src/compile.ts";
import { RouteRefused, resolveRoute } from "../src/routing.ts";
import { escalationId, failureTag, fromRunReport, runStatuses, stepOfKey } from "../src/run-report.ts";
import type { PeonRunResult, RunReport } from "../src/run-report.ts";
import { DESK, bool, forAll, pick, reviewTemplate, routing } from "./support.ts";

const requestFor = (workType: string, docs: Record<string, string>) =>
  Schema.decodeSync(PeonRequest)({ base: null, desk: DESK, input: { docs, kind: "brief", text: "Count the fences." }, runId: "run-7", schema: "peons.request.v1", scope: [], target: { kind: "work-type", workType } });

const compiledFor = (workType: string, docs: Record<string, string>): Compiled => {
  const resolved = resolveRoute(routing, workType);
  if (resolved instanceof RouteRefused) {throw resolved;}
  const out = compileRun(requestFor(workType, docs), resolved, "peon" in resolved.route.specialist ? reviewTemplate : null);
  if (out instanceof Prompt) {throw new TypeError(out.message);}
  return out;
};

const profile = compiledFor("scan", {});
const think = compiledFor("review", { subject: "diff --git a/x b/x\n+fence" });
const request = { desk: DESK, runId: "run-7" };

const goodVerdict = JSON.stringify({ blockers: [], checked: ["subject"], findings: [{ claim: "adds a fence", evidence: [{ quote: "+fence", source: "subject" }] }], schema: "peons.verdict.change-review.v1", unverified: [], verdict: "approve" });

const Scenario = Arbitrary.all({
  artifact: pick("none", "text", "verdict", "not-json", "wrong-schema"),
  awaiting: bool,
  failure: pick("none", "stream closed before the response finished", "failed to decode response body", "it reads {{docs.x}}, which no step has written on this run's path yet", "logic:x#1 failed"),
  message: bool,
  question: bool,
  rejected: bool,
  shape: pick("profile", "think"),
  status: pick(...runStatuses),
  thinking: bool,
});
interface Scenario { readonly shape: string; readonly status: (typeof runStatuses)[number]; readonly artifact: string; readonly awaiting: boolean; readonly message: boolean; readonly question: boolean; readonly failure: string; readonly thinking: boolean; readonly rejected: boolean }

const compiledOf = (s: Scenario) => (s.shape === "think" ? think : profile);
const artifactOf = (s: Scenario) => ({ none: undefined, "not-json": "{nope", text: "<svg/>", verdict: goodVerdict, "wrong-schema": JSON.stringify({ schema: "peons.verdict.change-review.v1", verdict: "maybe" }) })[s.artifact];

const reportOf = (s: Scenario): RunReport => {
  const out = compiledOf(s);
  const step = out.frozen.final;
  const artifact = artifactOf(s);
  return {
    docs: { ...out.docs, ...(artifact === undefined ? {} : { [out.frozen.writes]: artifact }) },
    planId: out.plan.id,
    planVersion: 1,
    runId: out.runId,
    status: s.status,
    transitions: 3,
    value: s.rejected ? "rejected" : step,
    ...(s.awaiting ? { awaiting: [{ key: step, messageId: `${out.runId}/${step}#1`, to: DESK, writes: null, ...(s.message ? { message: "Which fence?" } : {}) }] } : {}),
    ...(s.question ? { question: { answered: 0, key: step, options: ["pass", "fail"], question: "Does it pass?" } } : {}),
    ...(s.failure === "none" ? {} : { failures: [{ key: `logic:x.${out.plan.id}.${step}#1`, reason: s.failure }] }),
    ...(s.thinking ? { thinking: { line: "think: 1 call", tokens: { cacheRead: 2, input: 10, output: 5 } } } : {}),
  };
};

// What each generated report must map to: a think run is done only with a verdict that decodes.
const expected = (s: Scenario): string => {
  if (s.status === "done") {
    if (s.rejected || s.artifact === "none") {return "peon.failed";}
    return s.shape === "think" && s.artifact !== "verdict" ? "peon.failed" : "peon.done";
  }
  if (["failed", "aborted", "amendment-refused", "envelope-exceeded", "stuck"].includes(s.status)) {return "peon.failed";}
  if (s.status === "waiting-for-reply" && s.awaiting) {return "peon.blocked";}
  if (s.status === "waiting-for-joel" && s.question) {return "peon.blocked";}
  return "running";
};

const kind = (result: PeonRunResult) => ("type" in result ? result.type : result.status);

// Scenarios the planted bug cannot hide from: a done run with no artifact, in both shapes. Random
// generation reaches them only about once in a hundred draws, so they are always checked.
const witnesses: readonly Scenario[] = (["profile", "think"] as const).map((shape) => ({ artifact: "none", awaiting: false, failure: "none", message: false, question: false, rejected: false, shape, status: "done", thinking: false }));

const mapsExactly = async (map: (report: RunReport) => PeonRunResult) => {
  const holds = (s: Scenario): boolean => {
    const report = reportOf(s);
    const result = map(report);
    const decodes = Schema.is(RunResult)(result) && (!("type" in result) || Schema.is(PeonRecord)(result));
    const {writes} = compiledOf(s).frozen;
    const done = !("type" in result) || result.type !== "peon.done" || report.docs[writes] !== undefined;
    return decodes && done && kind(result) === expected(s);
  };
  const missed = witnesses.find((s) => !holds(s));
  if (missed !== undefined) {return `counterexample (witness): ${JSON.stringify(missed)}`;}
  return await forAll(Scenario, holds, 600);
};

const planted = (report: RunReport) => fromRunReport(report.status === "done" ? { ...report, docs: { artifact: "", review: goodVerdict, ...report.docs } } : report, request);

describe("fromRunReport", () => {
  it("maps every generated report to exactly one result across both shapes, and records decode with the contract's PeonRecord", async () => {
    expect(await mapsExactly((report) => fromRunReport(report, request))).toBeUndefined();
  });

  it("plant: a done record without the writes doc fails the property", async () => {
    expect(await mapsExactly(planted)).toBeDefined();
  });

  it("records a {profile} artifact by name, sha256 and size, never its contents, with a null template", () => {
    const result = fromRunReport(reportOf({ artifact: "text", awaiting: false, failure: "none", message: false, question: false, rejected: false, shape: "profile", status: "done", thinking: true }), request);
    expect(result).toMatchObject({ artifact: { bytes: 6, kind: "doc", name: "artifact", sha256: sha256("<svg/>") }, checks: [], route: { concept: "scan" }, template: null, tokens: { cacheRead: 2, input: 10, output: 5 }, type: "peon.done" });
    expect(JSON.stringify(result)).not.toContain("<svg/>");
  });

  it("decodes a think verdict before it calls the run done, and fails a doc that does not decode", () => {
    const done = fromRunReport(reportOf({ artifact: "verdict", awaiting: false, failure: "none", message: false, question: false, rejected: false, shape: "think", status: "done", thinking: false }), request);
    expect(done).toMatchObject({ artifact: { name: "review" }, checks: [{ name: "verdict-schema", outcome: "pass" }], template: { template: "fix-review", version: 1 }, type: "peon.done" });
    const bad = fromRunReport(reportOf({ artifact: "not-json", awaiting: false, failure: "none", message: false, question: false, rejected: false, shape: "think", status: "done", thinking: false }), request);
    expect(bad).toMatchObject({ tag: "VerdictInvalid", type: "peon.failed" });
  });

  it("takes a failed record's step and 4-line fields from failures[0], tagging transport drops", () => {
    const result = fromRunReport(reportOf({ artifact: "none", awaiting: false, failure: "stream closed before the response finished", message: false, question: false, rejected: false, shape: "profile", status: "failed", thinking: false }), request);
    expect(result).toMatchObject({ step: "work", tag: "stream-closed", type: "peon.failed" });
    expect(failureTag("failed to decode response body")).toBe("body-decode");
    expect(stepOfKey(`logic:root.${profile.plan.id}.a.b#2`, profile.plan.id)).toBe("a.b");
  });

  it("maps an ask to its messageId with no choices, preferring Mischief's message text when present", () => {
    const base = { artifact: "none", awaiting: true, failure: "none", question: false, rejected: false, shape: "think", status: "waiting-for-reply" as const, thinking: false };
    expect(fromRunReport(reportOf({ ...base, message: true }), request)).toMatchObject({ choices: [], messageId: `${think.runId}/peon#1`, question: "Which fence?", step: "peon", type: "peon.blocked" });
    const pointer = fromRunReport(reportOf({ ...base, message: false }), request);
    expect("type" in pointer && pointer.type === "peon.blocked" && pointer.question).toContain("peon_answer");
  });

  it("maps a judge escalation to its announce id, question and options as choices", () => {
    const report = reportOf({ artifact: "none", awaiting: false, failure: "none", message: false, question: true, rejected: false, shape: "profile", status: "waiting-for-joel", thinking: false });
    expect(fromRunReport(report, request)).toMatchObject({ choices: ["pass", "fail"], messageId: "announce:work#1", question: "Does it pass?", template: null, type: "peon.blocked" });
    expect(escalationId({ answered: 2, key: "work" })).toBe("announce:work#3");
  });

  it("maps a submit refusal to peon.refused PlanRefused with Mischief's errors, retrying the same runId", () => {
    const refused = fromRunReport({ errors: ["machine.states.peon: model \"x\" is outside the envelope"], kind: "submit-refused", route: null, template: "fix-review" }, request);
    expect(Schema.is(PeonRecord)(refused)).toBe(true);
    expect(refused).toMatchObject({ tag: "PlanRefused", type: "peon.refused" });
    expect("fix" in refused && refused.fix).toContain('runId "run-7"');
    expect("debug" in refused && refused.debug).toContain("outside the envelope");
  });

  it("refuses to build a record from a run that is not this request's", () => {
    const result = fromRunReport(reportOf({ artifact: "text", awaiting: false, failure: "none", message: false, question: false, rejected: false, shape: "profile", status: "done", thinking: false }), { desk: DESK, runId: "other" });
    expect(result).toMatchObject({ tag: "FrozenRouteMissing", type: "peon.refused" });
  });
});
