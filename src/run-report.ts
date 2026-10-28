// A Mischief run report becomes the contract's result for the desk that asked: a running handle or
// exactly one record. A blocked record is an ask waiting for a reply (choices []), or a judge
// escalation waiting for answerRun (choices are its options). The route, template and profile come from the run's own peon-frozen doc, so
// the mapping needs no local state and a crash between submit and record loses nothing. Records hold
// names, digests, sizes and counts; doc contents never leave the run.
//
// RunReport is derived from mischief/packages/core/src/runs/schema.ts (RunReportSchema and
// ReplyLineSchema), keeping the fields this mapping reads; decoding ignores the rest.
import { Result, Schema } from "effect";

import type { PeonRunResult as RunResult } from "./contract.ts";
import { FROZEN_DOC, Frozen, canonical, issuesOf, sha256 } from "./compile.ts";
import type { FrozenStep } from "./compile.ts";
import { verdicts } from "./verdicts.ts";
import type { ChangeReviewVerdict, InvestigationVerdict } from "./verdicts.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const MischiefRunId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/u));

export const runStatuses = [
  "running",
  "paused",
  "waiting-for-joel",
  "waiting-for-reply",
  "waiting-for-provider",
  "done",
  "envelope-exceeded",
  "amendment-refused",
  "aborted",
  "stuck",
  "failed",
] as const;
export const RunStatus = Schema.Literals(runStatuses);

// message is the ask's text; Mischief adds it in Brains's next deploy, so it is optional here.
export const Awaiting = Schema.Struct({ key: Schema.String, message: Schema.optionalKey(Schema.String), messageId: Schema.String, to: Schema.String, writes: Schema.NullOr(Schema.String) });

// The question a judge escalation waits on, answered with answerRun and one of its options.
export const Question = Schema.Struct({ answered: Count, key: Schema.String, options: Schema.Array(Schema.String), question: Schema.String, reason: Schema.optionalKey(Schema.String) });

export const RunReport = Schema.Struct({
  awaiting: Schema.optionalKey(Schema.Array(Awaiting)),
  docs: Schema.Record(Schema.String, Schema.Json),
  failures: Schema.optionalKey(Schema.Array(Schema.Struct({ key: Schema.String, reason: Schema.String }))),
  // Optional host-reported list cost. Absence means unknown, never zero dollars.
  listCostUsd: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  planId: Schema.String,
  planVersion: Count,
  question: Schema.optionalKey(Question),
  runId: MischiefRunId,
  status: RunStatus,
  thinking: Schema.optionalKey(Schema.Struct({ line: Schema.String, tokens: Schema.Struct({ cacheRead: Count, input: Count, output: Count }) })),
  transitions: Count,
  value: Schema.NullOr(Schema.String),
});
export type RunReport = typeof RunReport.Type;

export const ReplyLine = Schema.Struct({ body: Schema.String, replyTo: Schema.String, runId: Schema.optionalKey(MischiefRunId) });
export type ReplyLine = typeof ReplyLine.Type;

// A submit the host refused: Mischief's PlanRefused errors, plus what the compile froze.
export interface SubmitRefused {
  readonly kind: "submit-refused";
  readonly errors: readonly string[];
  readonly template: string;
  readonly route: FrozenStep["route"];
}

export type PeonRunResult = typeof RunResult.Type;
export interface Addressed {
  readonly runId: string;
  readonly desk: string;
}

const bounded = (text: string, limit = 300) => {
  const line = text.replaceAll(/\s+/gu, " ").trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
};

// Mischief's failure reasons are prose. These tags name the ones a desk can act on; stream-closed
// and body-decode are the provider transport drops Brains's proxy produces.
const failureTags: readonly (readonly [RegExp, string])[] = [
  [/stream[\s_-]*(?:was\s+)?closed|premature close|socket hang up|econnreset|terminated/iu, "stream-closed"],
  [/body[\s_-]*decode|decod(?:e|ing) (?:the )?(?:response )?body|unexpected end of json|invalid json/iu, "body-decode"],
  [/was cut before finishing/u, "redrive-exhausted"],
  [/which no step has written/u, "doc-missing"],
];

export const failureTag = (reason: string): string => failureTags.find(([pattern]) => pattern.test(reason))?.[1] ?? "step-failed";

// logic:<actor address>#<visit>, where the address ends ".<machine id>.<step key>".
export const stepOfKey = (key: string, planId: string) => {
  const bare = key.replace(/^[a-z-]+:/u, "").replace(/#\d+$/u, "");
  const marker = `.${planId}.`;
  const at = bare.indexOf(marker);
  return at === -1 ? bare : bare.slice(at + marker.length);
};

export const docText = (doc: Schema.Json) => (typeof doc === "string" ? doc : canonical(doc));

// The message id a judge escalation is announced under: Mischief's announce:<key>#<ask number>.
export const escalationId = (question: { readonly key: string; readonly answered: number }) => `announce:${question.key}#${question.answered + 1}`;

// A think template's output doc, decoded with the verdict schema it names. A doc that is not JSON, or
// does not decode, is a failed run, never a done one.
export type Verdict = typeof ChangeReviewVerdict.Type | typeof InvestigationVerdict.Type;
export const decodeVerdict = (name: keyof typeof verdicts, doc: Schema.Json): { readonly ok: true; readonly verdict: Verdict } | { readonly ok: false; readonly why: string } => {
  let value: unknown = doc;
  if (typeof doc === "string") {
    try {
      value = JSON.parse(doc);
    } catch {
      return { ok: false, why: "it is not JSON" };
    }
  }
  const decoded = Schema.decodeUnknownResult(verdicts[name], { errors: "all" })(value);
  return Result.isFailure(decoded) ? { ok: false, why: `it does not decode as ${name}: ${issuesOf(decoded.failure)}` } : { ok: true, verdict: decoded.success };
};

const decodeFrozen = Schema.decodeUnknownOption(Frozen);

export const frozenOf = (report: RunReport) => {
  const frozen = decodeFrozen(report.docs[FROZEN_DOC]);
  return frozen._tag === "Some" ? frozen.value : null;
};

const statusCall = (runId: string) => `peon_status({ runId: ${JSON.stringify(runId)} })`;

interface TokenUsage { readonly cacheRead: number; readonly input: number; readonly output: number }
interface Base { readonly desk: string; readonly runId: string; readonly schema: "peons.record.v1" }
interface FourLines { readonly tag: string; readonly accepted: string; readonly fix: string; readonly debug: string }

const planRefused = (input: SubmitRefused, request: Addressed, base: Base): PeonRunResult => ({
  ...base,
  accepted: "a plan Mischief's submitPlan accepts; this one was refused and nothing was stored",
  debug: `submitPlan refused it (HTTP 422): ${bounded(input.errors.join(" | ") || "Mischief gave no reason", 600)}`,
  fix: `fix ${input.errors[0] === undefined ? "the plan" : bounded(input.errors[0], 200)}, then call peon_run again with runId ${JSON.stringify(request.runId)}`,
  route: input.route,
  tag: "PlanRefused",
  template: input.template,
  type: "peon.refused",
});

interface Run {
  readonly report: RunReport;
  readonly request: Addressed;
  readonly base: Base;
  readonly frozen: Frozen;
  readonly final: FrozenStep;
  readonly debugAt: string;
  readonly stepFor: (state: string) => FrozenStep;
  readonly failed: (step: string, frozenStep: FrozenStep, four: FourLines) => PeonRunResult;
}

const doneRecord = ({ report, request, base, frozen, final, debugAt, failed }: Run, usage: TokenUsage): PeonRunResult => {
  const doc = report.docs[frozen.writes];
  if (report.value === "rejected")
    {return failed("rejected", final, { accepted: "a gate that passes: verify judged pass, or the owner replied approve", debug: `${debugAt} ended in its rejected state`, fix: `call peon_run or workflow_run with a new runId once the input is fixed`, tag: "Rejected" });}
  if (doc === undefined)
    {return failed(frozen.final, final, { accepted: `a finished run whose ${frozen.writes} doc is written`, debug: `${debugAt} finished without doc ${frozen.writes}`, fix: `call ${statusCall(request.runId)} and read which step skipped writing ${frozen.writes}`, tag: "ArtifactMissing" });}
  const checks = [];
  if (final.verdict !== null) {
    const verdict = decodeVerdict(final.verdict, doc);
    if (!verdict.ok)
      {return failed(frozen.final, final, { accepted: `a ${frozen.writes} doc that decodes as ${final.verdict}`, debug: `${debugAt} doc ${frozen.writes}: ${verdict.why}`, fix: `call peon_run with a new runId; read ${statusCall(request.runId)} first`, tag: "VerdictInvalid" });}
    checks.push({ detail: `${frozen.writes} decodes as ${final.verdict}`, name: "verdict-schema", outcome: "pass" as const });
  }
  const text = docText(doc);
  return {
    ...base,
    artifact: { bytes: Buffer.byteLength(text, "utf-8"), kind: "doc", name: frozen.writes, sha256: sha256(text) },
    checks,
    profile: final.profile,
    route: final.route,
    template: final.template,
    tokens: usage,
    type: "peon.done",
  };
};

const failedRecord = ({ report, request, frozen, debugAt, stepFor, failed }: Run): PeonRunResult => {
  const first = report.failures?.[0];
  const step = first === undefined ? frozen.final : stepOfKey(first.key, report.planId);
  const tag = first === undefined ? "step-failed" : failureTag(first.reason);
  return failed(step, stepFor(step.split(".")[0] ?? step), {
    accepted: "a run whose steps all finish",
    debug: first === undefined ? `${debugAt} failed with no failure entry` : `${debugAt} failures[0] at ${first.key}: ${bounded(first.reason)}`,
    fix: `call peon_run with a new runId after reading ${statusCall(request.runId)}; the failed run keeps its docs`,
    tag,
  });
};

const stoppedRecord = ({ report, request, frozen, final, debugAt, failed }: Run): PeonRunResult =>
  failed(report.value ?? frozen.final, final, {
    accepted: "a run that reaches its final state inside its envelope",
    debug: `${debugAt} is ${report.status} at ${report.value ?? "no state"}`,
    fix: report.status === "envelope-exceeded" ? `ask the run's owner to extendRun({ runId: ${JSON.stringify(report.runId)}, maxSteps }), then call ${statusCall(request.runId)}` : `call peon_run with a new runId`,
    tag: report.status,
  });

const replyBlocked = ({ report, request, base, stepFor }: Run): PeonRunResult | undefined => {
  const ask = report.awaiting?.[0];
  if (ask === undefined) {return undefined;}
  const step = stepOfKey(ask.key, report.planId);
  const owner = stepFor(step.split(".")[0] ?? step);
  return {
    ...base,
    choices: [],
    messageId: ask.messageId,
    question: ask.message !== undefined && ask.message.trim() !== "" ? ask.message : `Step ${step} asked ${ask.to} and waits for the reply to message ${ask.messageId}. Read it in that queue, then answer with peon_answer({ runId: ${JSON.stringify(request.runId)}, messageId: ${JSON.stringify(ask.messageId)}, answer }).`,
    recommendation: null,
    route: owner.route,
    step,
    template: owner.template,
    type: "peon.blocked",
  };
};

const joelBlocked = ({ report, base, stepFor }: Run): PeonRunResult | undefined => {
  const {question} = report;
  if (question === undefined) {return undefined;}
  const step = stepOfKey(question.key, report.planId);
  const owner = stepFor(step.split(".")[0] ?? step);
  return {
    ...base,
    choices: question.options.filter((option) => option !== ""),
    messageId: escalationId(question),
    question: question.question.trim() === "" ? `Step ${step} escalated a judgement; answer with one of its choices.` : question.question,
    recommendation: null,
    route: owner.route,
    step,
    template: owner.template,
    type: "peon.blocked",
  };
};

type Settle = (run: Run, usage: TokenUsage) => PeonRunResult | undefined;
const settlers: Readonly<Partial<Record<RunReport["status"], Settle>>> = {
  aborted: stoppedRecord,
  "amendment-refused": stoppedRecord,
  done: doneRecord,
  "envelope-exceeded": stoppedRecord,
  failed: failedRecord,
  stuck: stoppedRecord,
  "waiting-for-joel": joelBlocked,
  "waiting-for-reply": replyBlocked,
};

const settled = (run: Run, usage: TokenUsage): PeonRunResult | undefined => settlers[run.report.status]?.(run, usage);

export const fromRunReport = (input: RunReport | SubmitRefused, request: Addressed): PeonRunResult => {
  const base = { desk: request.desk, runId: request.runId, schema: "peons.record.v1" as const };
  if ("kind" in input) {return planRefused(input, request, base);}
  const report = input;
  const frozen = frozenOf(report);
  if (frozen === null || frozen.runId !== request.runId || frozen.desk !== request.desk) {
    return {
      ...base,
      accepted: `a run started by peon_run or workflow_run for ${request.desk}, whose ${FROZEN_DOC} doc names this runId`,
      debug: `inspectRun({ runId: ${JSON.stringify(report.runId)} }) has ${frozen === null ? `no valid ${FROZEN_DOC} doc` : `a ${FROZEN_DOC} doc for another run`}`,
      fix: `call ${statusCall(request.runId)} with the runId you passed to peon_run`,
      route: null,
      tag: "FrozenRouteMissing",
      template: "unknown",
      type: "peon.refused",
    };
  }
  const final = frozen.steps[frozen.final] ?? Object.values(frozen.steps)[0];
  if (final === undefined) {
    return { ...base, accepted: `a ${FROZEN_DOC} doc with at least one step`, debug: `inspectRun({ runId: ${JSON.stringify(report.runId)} })`, fix: `call ${statusCall(request.runId)} again after resubmitting through peon_run`, route: null, tag: "FrozenRouteMissing", template: "unknown", type: "peon.refused" };
  }
  const stepFor = (state: string): FrozenStep => frozen.steps[frozen.states[state] ?? ""] ?? final;
  const tokens = report.thinking?.tokens ?? { cacheRead: 0, input: 0, output: 0 };
  const usage = { cacheRead: tokens.cacheRead, input: tokens.input, output: tokens.output };
  const debugAt = `inspectRun({ runId: ${JSON.stringify(report.runId)} })`;
  const failed = (step: string, frozenStep: FrozenStep, four: FourLines): PeonRunResult => ({
    ...base,
    ...four,
    profile: frozenStep.profile,
    route: frozenStep.route,
    step,
    template: frozenStep.template,
    tokens: usage,
    type: "peon.failed",
  });
  return settled({ base, debugAt, failed, final, frozen, report, request, stepFor }, usage) ?? { runId: request.runId, status: "running", template: final.template };
};
