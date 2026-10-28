// Composed workflows schedule existing plans; Mischief still owns each plan's states and gates.
// Lifecycle sketch: waiting --inputs settled--> missing --submit/observe--> active
// active --done--> done; active --failure--> retryable --next attempt--> active
// retryable --cap--> failed; waiting --dependency failed--> failed. Reconcile has no effects.
import { Result, Schema } from "effect";

import { PeonRequest } from "./contract.ts";
import { DocKey, FROZEN_DOC, Frozen, INPUT_DOC, MischiefSubmission, Prompt, canonical, checkSubmission, compileRun, findThink, issuesOf, mischiefRunId, parseJson, prompt, sha256 } from "./compile.ts";
import type { Compiled } from "./compile.ts";
import { RouteRefused, resolveRoute } from "./routing.ts";
import type { Resolved } from "./routing.ts";
import { decodeVerdict } from "./run-report.ts";
import type { RunReport } from "./run-report.ts";
import { DefinedWorkflow, decodeDefinedWorkflow, workflowRun } from "./workflow.ts";
import type { WorkflowDeps } from "./workflow.ts";

const Name = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,23}$/u));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Cap = Schema.Int.check(Schema.isBetween({ maximum: 64, minimum: 1 }));
const Source = Schema.Struct({ from: Schema.String });
const Input = Schema.Struct({ docs: Schema.Record(DocKey, Source), text: Schema.String.check(Schema.isMinLength(1)) });
const Peon = Schema.Struct({ input: Input, kind: Schema.Literal("peon"), template: Schema.optionalKey(Schema.String), workType: Schema.optionalKey(Schema.String) });
// An already-defined v1 workflow is pinned, never expanded into separate submissions.
const Workflow = Schema.Struct({ input: Input, kind: Schema.Literal("workflow"), workflow: DefinedWorkflow });
const Task = Schema.Union([Peon, Workflow]);
const Step = Schema.Union([
  Schema.Struct({ id: Name, ...Peon.fields }),
  Schema.Struct({ id: Name, ...Workflow.fields }),
  Schema.Struct({ id: Name, kind: Schema.Literal("map"), over: Source, task: Task }),
  Schema.Struct({ from: Schema.String, id: Name, kind: Schema.Literal("gather"), writes: DocKey }),
]);
export const Composition = Schema.Struct({
  desk: PeonRequest.fields.desk,
  id: Name,
  retryCap: Schema.optionalKey(Cap),
  schema: Schema.Literal("peons.workflow.v2"),
  steps: Schema.NonEmptyArray(Step),
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type Composition = typeof Composition.Type;

const Seed = Schema.Struct({ docs: Schema.Record(DocKey, Schema.Json), frozen: Frozen, plan: MischiefSubmission, runId: Schema.String });
const BoundTask = Schema.Struct({
  input: Input,
  // Target doc names come from the compiler, not from user-chosen substitutions.
  limits: Schema.Record(DocKey, Schema.Int),
  seed: Seed,
  slots: Schema.Record(DocKey, Schema.String),
});
type BoundTask = typeof BoundTask.Type;
const BoundStep = Schema.Union([
  Schema.Struct({ id: Name, kind: Schema.Literal("leaf"), task: BoundTask }),
  Schema.Struct({ id: Name, kind: Schema.Literal("map"), over: Source, task: BoundTask }),
  Schema.Struct({ from: Schema.String, id: Name, kind: Schema.Literal("gather"), writes: DocKey }),
]);
export const DefinedComposition = Schema.Struct({
  definition: Composition,
  digest: Digest,
  schema: Schema.Literal("peons.workflow-plan.v2"),
  steps: Schema.NonEmptyArray(BoundStep),
});
export type DefinedComposition = typeof DefinedComposition.Type;

export const compositionRefused = (why: string) => prompt({ accepted: "a peons.workflow.v2 with earlier-step named doc sources, peon/workflow map tasks, <=64 batches per map, and retryCap 1..64 (default 2)", debug: "read src/workflow-v2.ts and docs/workflow-v2.md", did: "reconciled a composed workflow", fix: "correct the definition or input and call workflow_define / workflow_run again; nothing was submitted", tag: "WorkflowV2Refused", why: why.replaceAll(/\s+/gu, " ") });
const strict = { errors: "all", onExcessProperty: "error" } as const;
const inputRequest = (desk: string, input: PeonRequest["input"]): PeonRequest => ({ base: null, desk, input, runId: "definition", schema: "peons.request.v1", scope: [], target: { kind: "template", template: "workflow", version: null } });

const bindTask = (task: typeof Task.Type, desk: string, deps: WorkflowDeps): BoundTask | Prompt => {
  const docs = Object.fromEntries(Object.keys(task.input.docs).map((key) => [key, ""]));
  const request = inputRequest(desk, { docs, kind: "brief", text: task.input.text });
  if (task.kind === "workflow") {
    const defined = decodeDefinedWorkflow(task.workflow);
    if (defined instanceof Prompt) {return defined;}
    const seed = workflowRun(defined, request);
    if (seed instanceof Prompt) {return seed;}
    // v1's input is one named doc containing {text, docs}, exactly as workflowRun emits it.
    return { input: task.input, limits: {}, seed, slots: {} };
  }
  if ((task.template === undefined) === (task.workType === undefined)) {return compositionRefused("a peon must name exactly one of template or workType");}
  let resolved: Resolved | null = null;
  if (task.workType !== undefined) {
    const route = resolveRoute(deps.routing, task.workType);
    if (route instanceof RouteRefused) {return compositionRefused(route.message);}
    resolved = route;
  }
  const wanted = task.template ?? (resolved !== null && "peon" in resolved.route.specialist ? resolved.route.specialist.peon : undefined);
  const loaded = wanted === undefined ? null : findThink(deps.think, wanted);
  if (loaded === undefined) {return compositionRefused(`template ${wanted ?? ""} is not runnable`);}
  let target: PeonRequest["target"] = request.target;
  if (task.workType !== undefined) {target = { kind: "work-type", workType: task.workType };}
  else if (loaded !== null) {target = { kind: "template", template: loaded.spec.template, version: loaded.spec.version };}
  const seed = compileRun({ ...request, target }, resolved, loaded);
  if (seed instanceof Prompt) {return seed;}
  const slots = Object.fromEntries(Object.keys(docs).map((key) => [key, loaded === null ? `brief-${key}` : key]));
  const limits = Object.fromEntries((loaded?.spec.inputs ?? []).map(({ doc, maxBytes }) => [doc, maxBytes]));
  return { input: task.input, limits, seed, slots };
};

const sourcesOf = (task: BoundTask) => Object.values(task.input.docs).map(({ from }) => from);
const outputOf = (step: typeof BoundStep.Type) => step.kind === "gather" ? step.writes : step.task.seed.frozen.writes;
const checkSources = (sources: readonly string[], earlier: readonly typeof BoundStep.Type[], allowBatch: boolean): Prompt | undefined => {
  for (const from of sources) {
    if (from === "batch" && allowBatch) {continue;}
    const [parent, doc, extra] = from.split(".");
    if (parent === "input" && doc !== undefined && extra === undefined && Schema.is(DocKey)(doc)) {continue;}
    const step = earlier.find(({ id }) => id === parent);
    if (step === undefined || doc !== outputOf(step) || extra !== undefined) {return compositionRefused(`unknown or forward doc ${from}`);}
  }
  return undefined;
};
export const defineComposition = (raw: unknown, deps: WorkflowDeps): DefinedComposition | Prompt => {
  const decoded = Schema.decodeUnknownResult(Composition, strict)(raw);
  if (Result.isFailure(decoded)) {return compositionRefused(issuesOf(decoded.failure));}
  const definition = decoded.success;
  const steps: (typeof BoundStep.Type)[] = [];
  for (const step of definition.steps) {
    if (step.id === "input" || steps.some(({ id }) => id === step.id)) {return compositionRefused(`step id ${step.id} is reserved or repeated`);}
    if (step.kind === "gather") {
      const source = steps.find(({ id }) => id === step.from);
      if (source?.kind !== "map") {return compositionRefused(`gather ${step.id} must name an earlier map`);}
      steps.push(step);
      continue;
    }
    const task = bindTask(step.kind === "map" ? step.task : step, definition.desk, deps);
    if (task instanceof Prompt) {return task;}
    const invalidInput = checkSources(sourcesOf(task), steps, step.kind === "map");
    if (invalidInput !== undefined) {return invalidInput;}
    if (step.kind === "map") {
      const invalidOver = checkSources([step.over.from], steps, false);
      if (invalidOver !== undefined) {return invalidOver;}
    }
    steps.push(step.kind === "map" ? { id: step.id, kind: "map", over: step.over, task } : { id: step.id, kind: "leaf", task });
  }
  const bound = Schema.decodeUnknownResult(Schema.NonEmptyArray(BoundStep))(steps);
  if (Result.isFailure(bound)) {return compositionRefused(`compiled leaf does not decode: ${issuesOf(bound.failure)}`);}
  const body = { definition, steps: bound.success };
  return { ...body, digest: sha256(canonical(body)), schema: "peons.workflow-plan.v2" };
};

export const decodeComposition = (raw: unknown): DefinedComposition | Prompt => {
  const decoded = Schema.decodeUnknownResult(DefinedComposition, strict)(raw);
  if (Result.isFailure(decoded)) {return compositionRefused(issuesOf(decoded.failure));}
  const defined = decoded.success;
  if (defined.digest !== sha256(canonical({ definition: defined.definition, steps: defined.steps }))) {return compositionRefused("the v2 definition digest does not match its contents");}
  // Bound plans must still pass Mischief validation even when no leaf is ready yet.
  for (const step of defined.steps) {
    if (step.kind === "gather") {continue;}
    const errors = checkSubmission(step.task.seed.plan, Object.keys(step.task.seed.docs));
    if (errors.length > 0) {return compositionRefused(errors.join("; "));}
  }
  return defined;
};

export interface Observed {
  readonly input: Readonly<Record<string, Schema.Json>>;
  // Keys are actual Mischief run ids, never positional leaf indices.
  readonly runs: Readonly<Record<string, RunReport>>;
}
export interface Attempt {
  readonly attempt: number;
  readonly path: string;
  readonly runId: string;
  readonly compiled: Compiled;
  readonly batch: Schema.Json | null;
}
export type LeafStatus = "missing" | "active" | "done" | "failed";
export interface Leaf {
  readonly path: string;
  readonly status: LeafStatus;
  readonly attempts: readonly Attempt[];
  readonly latest: Attempt;
  readonly report: RunReport | undefined;
}
export interface Reconciled {
  readonly status: "running" | "done" | "failed";
  readonly submit: readonly Attempt[];
  readonly inspect: readonly string[];
  readonly leaves: readonly Leaf[];
  readonly docs: Readonly<Record<string, Schema.Json>>;
  readonly steps: Readonly<Record<string, "waiting" | "active" | "done" | "failed">>;
}

// Hash all inputs (including the bound profile) before allocating attempt suffixes.
export const attemptId = (workflowDigest: string, path: string, inputDigests: unknown, boundProfile: unknown, attempt: number, desk: string) =>
  `${mischiefRunId(desk, sha256(canonical({ boundProfile, inputDigests, path, workflowDigest })))}-a${attempt}`;

const materialize = (task: BoundTask, docs: Readonly<Record<string, Schema.Json>>, runId: string): Compiled | Prompt => {
  const textDocs = Object.fromEntries(Object.entries(docs).map(([key, value]) => [key, typeof value === "string" ? value : canonical(value)]));
  for (const [key, limit] of Object.entries(task.limits)) {
    if (textDocs[key] !== undefined && Buffer.byteLength(textDocs[key], "utf-8") > limit) {return compositionRefused(`input doc ${key} exceeds ${limit} bytes`);}
  }
  const frozen = { ...task.seed.frozen, runId };
  const input: Schema.Json = Object.keys(task.slots).length === 0 && Object.keys(textDocs).length > 0
    ? { docs: textDocs, text: task.input.text }
    : task.input.text;
  const seeded: Record<string, Schema.Json> = { ...task.seed.docs, [INPUT_DOC]: input, [FROZEN_DOC]: parseJson(canonical(frozen)) };
  // Think templates use brief; profile and v1 plans use peon-input.
  if ("brief" in seeded) {seeded.brief = task.input.text;}
  for (const [key, slot] of Object.entries(task.slots)) {
    if (textDocs[key] !== undefined) {seeded[slot] = textDocs[key];}
  }
  return { docs: seeded, frozen, plan: task.seed.plan, runId };
};

const failed = (report: RunReport) => ["failed", "aborted", "stuck", "envelope-exceeded", "amendment-refused"].includes(report.status) || (report.status === "done" && report.value === "rejected");
const invalidVerdict = (task: BoundTask, report: RunReport): boolean => {
  if (report.status !== "done") {return false;}
  const verdict = task.seed.frozen.steps[task.seed.frozen.final]?.verdict;
  if (verdict === null || verdict === undefined) {return false;}
  const raw = report.docs[task.seed.frozen.writes];
  return raw === undefined || !decodeVerdict(verdict, raw).ok;
};
const valueOf = (doc: Schema.Json): Schema.Json | Prompt => {
  if (typeof doc !== "string") {return doc;}
  try {return parseJson(doc);} catch {return compositionRefused("a map or verdict doc is not JSON");}
};
const Item = Schema.Struct({ id: Schema.String.check(Schema.isMinLength(1)) });
const Verdict = Schema.Struct({ items: Schema.Array(Schema.Struct({ id: Schema.String, verdict: Schema.Json })) });
// A done host run is not a successful map attempt until its verdict covers its batch exactly.
// Share this decoder with gather so retry eligibility and the final guard cannot drift apart.
const batchVerdict = (batch: Schema.Json, raw: Schema.Json | undefined, path: string): typeof Verdict.Type | Prompt => {
  if (raw === undefined) {return compositionRefused(`leaf ${path} has no verdict doc`);}
  const value = valueOf(raw);
  if (value instanceof Prompt) {return value;}
  const expectedBatch = Schema.decodeUnknownResult(Schema.Array(Item))(batch);
  const decoded = Schema.decodeUnknownResult(Verdict)(value);
  if (Result.isFailure(expectedBatch) || Result.isFailure(decoded)) {return compositionRefused(`leaf ${path} needs a batch of {id} items and a verdict {items:[{id,verdict}]}`);}
  const expected = expectedBatch.success.map(({ id }) => id);
  const actual = decoded.success.items.map(({ id }) => id);
  if (new Set(expected).size !== expected.length || new Set(actual).size !== actual.length || canonical(expected.toSorted()) !== canonical(actual.toSorted())) {return compositionRefused(`leaf ${path} verdict ids do not match its batch 1:1`);}
  return decoded.success;
};
const invalidBatchVerdict = (task: BoundTask, batch: Schema.Json | null, report: RunReport, path: string): boolean =>
  report.status === "done" && batch !== null && batchVerdict(batch, report.docs[task.seed.frozen.writes], path) instanceof Prompt;

type StepStatus = Reconciled["steps"][string];
const metrics = (leaf: Leaf, runs: Observed["runs"]): Schema.Json => {
  let cost: number | null = 0;
  let tokens: { cacheRead: number; input: number; output: number } | null = { cacheRead: 0, input: 0, output: 0 };
  const attempts: Schema.Json[] = [];
  for (const { runId } of leaf.attempts) {
    const report = runs[runId];
    const usage = report?.thinking?.tokens;
    const price = report?.listCostUsd;
    cost = cost === null || price === undefined ? null : cost + price;
    if (usage === undefined) {tokens = null;}
    else if (tokens !== null) {tokens = { cacheRead: tokens.cacheRead + usage.cacheRead, input: tokens.input + usage.input, output: tokens.output + usage.output };}
    attempts.push({ cost: price ?? null, runId, tokens: usage ?? null });
  }
  return { attempts, cost, leaf: leaf.path, tokens };
};

const readBatches = (from: string, docs: Readonly<Record<string, Schema.Json>>): readonly Schema.Json[] | Prompt => {
  const raw = docs[from];
  if (raw === undefined) {return compositionRefused(`missing map doc ${from}`);}
  const value = valueOf(raw);
  if (value instanceof Prompt) {return value;}
  if (!Array.isArray(value) || value.length > 64) {return compositionRefused(`map ${from} needs a list of at most 64 batches`);}
  const decoded = Schema.decodeResult(Schema.Array(Schema.Array(Item)))(value);
  if (Result.isFailure(decoded)) {return compositionRefused(`map ${from} needs batches of {id} items`);}
  const ids = decoded.success.flatMap((batch) => batch.map(({ id }) => id));
  if (new Set(ids).size !== ids.length) {return compositionRefused(`map ${from} repeats item ids within or across batches`);}
  return Schema.decodeSync(Schema.Array(Schema.Json))(value);
};

const readiness = (sources: readonly string[], docs: Readonly<Record<string, Schema.Json>>, steps: Reconciled["steps"]): StepStatus | Prompt => {
  if (sources.some((from) => steps[from.split(".")[0] ?? ""] === "failed")) {return "failed";}
  const missing = sources.filter((from) => docs[from] === undefined);
  if (missing.some((from) => from.startsWith("input."))) {return compositionRefused(`missing input docs: ${missing.join(", ")}`);}
  return missing.length > 0 ? "waiting" : "active";
};

const settleLeaf = (definition: DefinedComposition, task: BoundTask, path: string, batch: Schema.Json | null, docs: Readonly<Record<string, Schema.Json>>, runs: Observed["runs"]): Leaf | Prompt => {
  const inputs = Object.fromEntries(Object.entries(task.input.docs).map(([key, { from }]) => [key, from === "batch" ? batch : docs[from] ?? null]));
  const inputDigests = Object.fromEntries(Object.entries(inputs).map(([key, doc]) => [key, sha256(canonical(doc))]));
  inputDigests.batch = sha256(canonical(batch));
  const profiles = Object.fromEntries(Object.entries(task.seed.frozen.steps).map(([key, frozen]) => [key, frozen.profile]));
  const attempts: Attempt[] = [];
  const cap = definition.definition.retryCap ?? 2;
  for (let attempt = 1; attempt <= cap; attempt += 1) {
    const runId = attemptId(definition.digest, path, inputDigests, profiles, attempt, definition.definition.desk);
    const compiled = materialize(task, inputs, runId);
    if (compiled instanceof Prompt) {return compiled;}
    const next: Attempt = { attempt, batch, compiled, path, runId };
    attempts.push(next);
    const report = runs[runId];
    if (report === undefined) {return { attempts, latest: next, path, report, status: "missing" };}
    if (failed(report) || invalidVerdict(task, report) || invalidBatchVerdict(task, batch, report, path)) {
      if (attempt < cap) {continue;}
      return { attempts, latest: next, path, report, status: "failed" };
    }
    return { attempts, latest: next, path, report, status: report.status === "done" ? "done" : "active" };
  }
  return compositionRefused("attempt allocation exhausted without a leaf state");
};

const leafStatus = (leaves: readonly Leaf[]): StepStatus => {
  if (leaves.some(({ status }) => status === "failed")) {return "failed";}
  return leaves.every(({ status }) => status === "done") ? "done" : "active";
};
const overall = (steps: Reconciled["steps"]): Reconciled["status"] => {
  if (Object.values(steps).includes("failed")) {return "failed";}
  return Object.values(steps).every((state) => state === "done") ? "done" : "running";
};

// Gather is ordinary code, not another model plan. Missing/malformed/duplicate/foreign verdicts fail.
export const gather = (leaves: readonly Leaf[]): Schema.Json | Prompt => {
  const items: Schema.Json[] = [];
  const costs: Schema.Json[] = [];
  const seen = new Set<string>();
  for (const leaf of leaves) {
    const {report} = leaf;
    if (leaf.status !== "done" || report === undefined || leaf.latest.batch === null) {return compositionRefused(`gather leaf ${leaf.path} is not done with a batch`);}
    const decoded = batchVerdict(leaf.latest.batch, report.docs[leaf.latest.compiled.frozen.writes], leaf.path);
    if (decoded instanceof Prompt) {return decoded;}
    for (const item of decoded.items) {
      if (seen.has(item.id)) {return compositionRefused(`gather repeats item ${item.id} across batches`);}
      seen.add(item.id);
      items.push({ ...item, leaf: leaf.path });
    }
    // Retried leaves include all attempts' usage below in reconcile's observed reports.
    costs.push({ attempts: leaf.attempts.map(({ runId }) => runId), leaf: leaf.path, runId: leaf.latest.runId });
  }
  return { items, leaves: costs };
};

const stepPath = (step: typeof BoundStep.Type, index: number) => step.kind === "map" ? `${step.id}/map[${index}]` : step.id;

export const reconcile = (definition: DefinedComposition, observed: Observed): Reconciled | Prompt => {
  const checked = decodeComposition(definition);
  if (checked instanceof Prompt) {return checked;}
  const docs: Record<string, Schema.Json> = Object.fromEntries(Object.entries(observed.input).map(([key, doc]) => [`input.${key}`, doc]));
  const steps: Record<string, "waiting" | "active" | "done" | "failed"> = {};
  const allLeaves: Leaf[] = [];
  const byStep = new Map<string, readonly Leaf[]>();
  const submit: Attempt[] = [];
  const inspect: string[] = [];
  for (const step of definition.steps) {
    if (step.kind === "gather") {
      const source = byStep.get(step.from);
      if (steps[step.from] === "failed") {steps[step.id] = "failed"; continue;}
      if (source === undefined || steps[step.from] !== "done") {steps[step.id] = "waiting"; continue;}
      const gathered = gather(source);
      if (gathered instanceof Prompt) {return gathered;}
      const costs = source.map((leaf) => metrics(leaf, observed.runs));
      docs[`${step.id}.${step.writes}`] = { ...Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Schema.Json) }))(gathered), leaves: costs };
      steps[step.id] = "done";
      continue;
    }
    const sources = [...sourcesOf(step.task).filter((from) => from !== "batch"), ...(step.kind === "map" ? [step.over.from] : [])];
    const ready = readiness(sources, docs, steps);
    if (ready instanceof Prompt) {return ready;}
    if (ready !== "active") {steps[step.id] = ready; continue;}
    const batches = step.kind === "map" ? readBatches(step.over.from, docs) : [null];
    if (batches instanceof Prompt) {return batches;}
    const leaves: Leaf[] = [];
    for (const [index, batch] of batches.entries()) {
      const path = stepPath(step, index);
      const leaf = settleLeaf(definition, step.task, path, batch, docs, observed.runs);
      if (leaf instanceof Prompt) {return leaf;}
      inspect.push(...leaf.attempts.map(({ runId }) => runId));
      if (leaf.status === "missing") {submit.push(leaf.latest);}
      leaves.push(leaf);
    }
    byStep.set(step.id, leaves);
    allLeaves.push(...leaves);
    steps[step.id] = leafStatus(leaves);
    if (steps[step.id] === "done") {
      const outputs = leaves.map((leaf) => leaf.report?.docs[leaf.latest.compiled.frozen.writes]);
      if (outputs.some((doc) => doc === undefined)) {return compositionRefused(`done step ${step.id} has no output doc`);}
      docs[`${step.id}.${outputOf(step)}`] = step.kind === "map" ? outputs.map((doc) => doc ?? null) : outputs[0] ?? null;
    }
  }
  return { docs, inspect, leaves: allLeaves, status: overall(steps), steps, submit };
};
