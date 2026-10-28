// Shared test fixtures: fixture routing, catalog and think tables built here (the live routing.json
// and catalog.json are read only by the seam tests), an in-memory Mischief host that keeps runs by
// runId the way submitPlan does, in-memory files, and a property runner that returns the first
// counterexample so a planted bug can be shown to fail its property.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { CatalogEntry } from "../src/contract.ts";
import { canonical, prompt } from "../src/compile.ts";
import type { MischiefSubmission } from "../src/compile.ts";
import { RoutingTable } from "../src/routing.ts";
import type { ReplyLine, RunReport } from "../src/run-report.ts";
import { COMPILER, ThinkTemplate, canonical as templateCanonical } from "../src/think-template.ts";
import type { LoadedTemplate } from "../src/think-template.ts";
import type { Catalog } from "../extensions/pi/catalog.ts";
import { AnswerRefused, PlanRefused, ReplyRefused, UnknownRun } from "../extensions/pi/host.ts";
import type { RunHostPort } from "../extensions/pi/host.ts";
import { makeTools } from "../extensions/pi/tools.ts";
import type { Files } from "../extensions/pi/tools.ts";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DESK = "agent-graph/desk";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export const routing: RoutingTable = Schema.decodeSync(RoutingTable)({
  routes: {
    ask: { source: "test", specialist: { peon: "fix-ask@2" }, status: "provisional", why: "fixture ask" },
    review: { source: "test", specialist: { peon: "fix-review@1" }, status: "provisional", why: "fixture review" },
    scan: { source: "test", specialist: { profile: { model: "openai-codex/gpt-6-luna", thinking: "low" } }, status: "measured", why: "fixture scan" },
    work: { source: "test", specialist: { profile: { model: "openai-codex/gpt-6.1-sol", thinking: "medium" } }, status: "provisional", why: "fixture default" },
  },
  schema: "agent-graph.routing.v0.1",
  scheme: {
    concepts: { ask: { broader: ["work"] }, ask_deep: { broader: ["ask"] }, docs: { broader: ["work"] }, gather: { broader: ["work"] }, review: { broader: ["work"] }, scan: { broader: ["work"] }, work: { broader: [] } },
    id: "fixture",
    version: 1,
  },
  version: 3,
});

const think = (spec: unknown, rules: string, task: string): LoadedTemplate => {
  const decoded = Schema.decodeUnknownSync(ThinkTemplate)(spec);
  return { digest: sha(templateCanonical({ compiler: COMPILER, spec: decoded })), prompt: task, spec: decoded, warmup: { rules } };
};
const fileRef = (path: string, text: string) => ({ path, sha256: sha(text) });

export const reviewTemplate = think(
  { inputs: [{ doc: "subject", maxBytes: 1000, required: true }, { doc: "criteria", maxBytes: 1000, required: false }], kind: "judge", maxSteps: 4, output: { doc: "review", verdict: "peons.verdict.change-review.v1" }, owner: "agent-graph/desk", profile: { model: "sol", thinking: "high" }, prompt: fileRef("prompt.md", "Review the subject."), schema: "peons.think-template.v1", template: "fix-review", version: 1, warmup: [{ doc: "rules", ...fileRef("warmup.md", "Review rules.") }] },
  "Review rules.",
  "Review the subject.",
);
export const askTemplate = think(
  { inputs: [{ doc: "evidence", maxBytes: 2000, required: true }, { doc: "context", maxBytes: 500, required: false }], kind: "read", maxSteps: 4, output: { doc: "answer", verdict: "peons.verdict.investigation.v1" }, owner: "agent-graph/desk", profile: { model: "gpt-6-luna", thinking: "medium" }, prompt: fileRef("prompt.md", "Answer from the evidence."), schema: "peons.think-template.v1", template: "fix-ask", version: 2, warmup: [{ doc: "rules", ...fileRef("warmup.md", "Ask rules.") }] },
  "Ask rules.",
  "Answer from the evidence.",
);

const entry = (template: string, version: number, kind: string, model: string, thinking: string, cellReady = true) =>
  Schema.decodeUnknownSync(CatalogEntry)({ cellReady, evidence: { count: 1, repoCount: 1, source: "test" }, input: "i", kind, model, needs: cellReady ? ["model-only"] : ["shell"], output: "o", owner: DESK, refusals: [], summary: "s", template, thinking, verify: "v", version });

export const catalog: Catalog = {
  entries: [entry("fix-review", 1, "judge", "sol", "high"), entry("fix-ask", 2, "read", "gpt-6-luna", "medium"), entry("fix-build", 1, "work", "sol", "high", false)],
  problems: [],
  routing,
  think: [reviewTemplate, askTemplate],
  unlisted: [{ digest: "0".repeat(64), model: "openai-codex/gpt-6.1-sol", template: "fix-tool", thinking: "medium", version: 1 }],
};

export const forAll = async <A>(arbitrary: Arbitrary.Arbitrary<A>, property: (value: A) => boolean | Promise<boolean>, runs = 200): Promise<string | undefined> => {
  const result = await Effect.runPromise(Arbitrary.checkEffect(arbitrary, (value) => Effect.promise(async () => await property(value)), { runs }));
  return Arbitrary.formatCheckFailure(result);
};

export const pick = <const A extends readonly [string, ...string[]]>(...values: A) => Arbitrary.schema(Schema.Literals(values));
export const int = (minimum: number, maximum: number) => Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum, minimum })));
export const bool = Arbitrary.schema(Schema.Boolean);

export interface FakeHost {
  readonly host: RunHostPort;
  readonly runs: Map<string, { body: string; report: RunReport }>;
  readonly calls: { submit: string[]; charges: string[]; inspect: string[]; deliver: ReplyLine[]; answer: { runId: string; reply: string }[] };
  readonly patch: (runId: string, change: Partial<RunReport>) => void;
}

export const fakeHost = (): FakeHost => {
  const runs = new Map<string, { body: string; report: RunReport }>();
  const calls: FakeHost["calls"] = { answer: [], charges: [], deliver: [], inspect: [], submit: [] };
  const host: RunHostPort = {
    answer: (runId, reply) =>
      Effect.suspend((): Effect.Effect<RunReport, UnknownRun | AnswerRefused> => {
        calls.answer.push({ reply, runId });
        const run = runs.get(runId);
        if (run === undefined) {return Effect.fail(new UnknownRun({ runId }));}
        const {question} = run.report;
        if (question === undefined || !question.options.includes(reply)) {return Effect.fail(new AnswerRefused({ reason: "no open question takes that reply", runId }));}
        const { question: _question, ...rest } = run.report;
        run.report = { ...rest, status: "running" };
        return Effect.succeed(run.report);
      }),
    deliver: (line) =>
      Effect.suspend(() => {
        calls.deliver.push(line);
        const run = runs.get(line.runId ?? "");
        if (run === undefined || !(run.report.awaiting ?? []).some(({ messageId }) => messageId === line.replyTo)) {return Effect.fail(new ReplyRefused({ reason: "no open ask has that message id", replyTo: line.replyTo }));}
        const { awaiting: _awaiting, ...rest } = run.report;
        run.report = { ...rest, status: "running" };
        return Effect.succeed(run.report);
      }),
    inspect: (runId) =>
      Effect.suspend(() => {
        calls.inspect.push(runId);
        const run = runs.get(runId);
        return run === undefined ? Effect.fail(new UnknownRun({ runId })) : Effect.succeed(run.report);
      }),
    submit: (runId: string, plan: MischiefSubmission, docs) =>
      Effect.suspend(() => {
        calls.submit.push(runId);
        const body = canonical(plan);
        const existing = runs.get(runId);
        if (existing !== undefined) {
          if (existing.body === body) {return Effect.succeed(existing.report);}
          return Effect.fail(new PlanRefused({ errors: [prompt({ accepted: "the same plan body, or a revision", debug: "inspectRun", did: `submitted run ${runId}`, fix: `call reviseRun({ runId: "${runId}", plan, dryRun: true })`, tag: "PlanRefused", why: "a run with this id holds a different plan" }).message] }));
        }
        calls.charges.push(runId);
        const report: RunReport = { docs: { ...docs }, planId: plan.id, planVersion: 1, runId, status: "running", transitions: 0, value: plan.machine.initial };
        runs.set(runId, { body, report });
        return Effect.succeed(report);
      }),
  };
  const patch = (runId: string, change: Partial<RunReport>) => {
    const run = runs.get(runId);
    if (run !== undefined) {run.report = { ...run.report, ...change };}
  };
  return { calls, host, patch, runs };
};

export const memoryFiles = () => {
  const store = new Map<string, string>();
  const files: Files = {
    read: (path) => Effect.sync(() => (store.has(path) ? new TextEncoder().encode(store.get(path)) : null)),
    write: (path, text) => Effect.sync(() => {
        store.set(path, text);
      }),
  };
  return { files, store };
};

export const toolsWith = (host: RunHostPort, files: Files = memoryFiles().files) => makeTools({ catalog, cwd: "/work", desk: Effect.succeed(DESK), files, host: Effect.succeed(host) });

export const jsonResponse = async (body: unknown, status = 200) => await Promise.resolve(Response.json(body, { status }));

export const urlText = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") {return input;}
  return input instanceof URL ? input.href : input.url;
};

export const bodyText = (init: RequestInit | undefined): string => (typeof init?.body === "string" ? init.body : "");

export const run = async <A>(effect: Effect.Effect<A>) => await Effect.runPromise(effect);

export { mischiefRunId } from "../src/compile.ts";
