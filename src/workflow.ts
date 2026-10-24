// A workflow is one Mischief plan. workflow_define resolves every step's route now, freezes it into
// the plan, and returns plan data; workflow_run seeds the input and the frozen routes and submits it.
// There is no second engine: ordering, visits, gates and waits are Mischief states.
//
// Steps compile in order. A peon step is a think that writes the doc named by its id. A verify gate is
// a judge over that doc; an owner-approve gate is an ask to the workflow's desk and a switch on the
// reply. Either gate's "no" ends the run in its rejected state. The only failure policy is stop, which
// is Mischief's own behaviour: a failed step fails the run.
import { Result, Schema } from "effect";

import { PeonRequest } from "./contract.ts";
import {
  AgentConfig,
  DOC_REF,
  FROZEN_DOC,
  FrozenStep,
  INPUT_DOC,
  MischiefSubmission,
  Prompt,
  StateKey,
  DocKey,
  ThinkStep,
  canonical,
  checkSubmission,
  findThink,
  issuesOf,
  mischiefRunId,
  parseJson,
  profileOf,
  promptOfRefused,
  prompt,
  sha256,
  templateRefOf,
  thinkNames,
  thinkPrompt,
  thinkingMax,
} from "./compile.ts";
import type { Compiled, MischiefStep, StateNode ,
  Frozen} from "./compile.ts";
import { RouteRefused, resolveRoute, routeRecord } from "./routing.ts";
import type { Resolved, RoutingTable } from "./routing.ts";
import { byKey, compile as compileTemplate } from "./think-template.ts";
import type { LoadedTemplate } from "./think-template.ts";

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

export const stepKinds = ["peon"] as const;
export const gates = ["verify", "owner-approve"] as const;
export const failurePolicies = ["stop"] as const;
const STEP_ID = /^[a-z][a-z0-9]{0,23}$/u;
const RESERVED = new Set(["done", "rejected", "input"]);
const oneOf = (accepted: readonly string[], value: string) => accepted.includes(value);

// from lists the docs a {profile} step reads; docs maps each declared input of a templated step to
// "input" or an earlier step id.
export const WorkflowStep = Schema.Struct({
  check: Schema.optionalKey(NonEmpty),
  failurePolicy: Schema.optionalKey(Schema.String),
  gate: Schema.optionalKey(Schema.String),
  id: Schema.String,
  input: Schema.Struct({ docs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)), from: Schema.optionalKey(Schema.Array(Schema.String)), text: NonEmpty }),
  kind: Schema.String,
  template: Schema.optionalKey(Schema.String),
  workType: Schema.optionalKey(Schema.String),
});
export type WorkflowStep = typeof WorkflowStep.Type;

export const WorkflowDefinition = Schema.Struct({
  desk: PeonRequest.fields.desk,
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,47}$/u)),
  schema: Schema.Literal("peons.workflow.v1"),
  steps: Schema.NonEmptyArray(WorkflowStep),
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type WorkflowDefinition = typeof WorkflowDefinition.Type;

// The versioned workflow doc workflow_define writes and workflow_run reads.
export const DefinedWorkflow = Schema.Struct({
  definition: WorkflowDefinition,
  digest: Sha256,
  docs: Schema.Record(DocKey, Schema.String),
  final: StateKey,
  plan: MischiefSubmission,
  schema: Schema.Literal("peons.workflow-plan.v1"),
  states: Schema.Record(StateKey, StateKey),
  steps: Schema.Record(StateKey, FrozenStep),
  writes: DocKey,
});
export type DefinedWorkflow = typeof DefinedWorkflow.Type;

export const ACCEPTED_SHAPE =
  'peons.workflow.v1: { schema, id, version, desk, steps: [{ id, kind: "peon", template: "<name>[@<version>]" | workType: "<concept>", input: { text, from?: ["input" | <earlier step id>], docs?: { <template input>: "input" | <earlier step id> } }, gate?: "verify" | "owner-approve", check?, failurePolicy?: "stop" }] }';
const DEBUG = "read src/workflow.ts in joelhooks/peons";
const FIX = "call workflow_define({ workflow }) with the step fixed";

const refuse = (tag: string, why: string, accepted: string, fix = FIX) => prompt({ accepted, debug: DEBUG, did: "called workflow_define", fix, tag, why });

export interface WorkflowDeps {
  readonly routing: RoutingTable;
  readonly think: readonly LoadedTemplate[];
}

// What one step compiles to before the gates: its think, its seeded docs and what it freezes.
interface Planned {
  readonly step: WorkflowStep;
  readonly think: typeof ThinkStep.Type;
  readonly docs: Readonly<Record<string, string>>;
  readonly frozen: FrozenStep;
}

const docOf = (name: string) => (name === "input" ? INPUT_DOC : name);

const ThinkPart = Schema.Struct({
  defaults: Schema.Struct({ agent: AgentConfig }),
  machine: Schema.Struct({ states: Schema.Record(Schema.String, Schema.Unknown) }),
});
const ThinkState = Schema.Struct({ meta: Schema.Struct({ step: ThinkStep }) });
const decodeThinkPart = Schema.decodeUnknownResult(ThinkPart);
const decodeThinkState = Schema.decodeUnknownOption(ThinkState);

// A templated step: think-template.ts compiles it as a one-step plan, and the step's think comes out
// of that plan with its docs renamed for this workflow. The template's warmups and brief become
// <step>-<doc>, each declared input reads the doc its source writes, and the output is the doc named
// by the step id, so two steps on one template never share a doc.
const templatedStep = (step: WorkflowStep, at: string, loaded: LoadedTemplate, resolved: Resolved | null, definition: WorkflowDefinition): Planned | Prompt => {
  const { spec } = loaded;
  const named = `${spec.template}@${spec.version}`;
  if ((step.input.from ?? []).length > 0) {return refuse("InputRefused", `${at} runs ${named} and lists input.from; a templated step maps its declared inputs in input.docs`, `input.docs with keys from ${spec.inputs.map(({ doc }) => doc).join(", ")}`);}
  const mapped = step.input.docs ?? {};
  const placeholder = Object.fromEntries(Object.keys(mapped).map((name) => [name, `{{docs.${name}}}`]));
  const request = Schema.decodeResult(PeonRequest)({ base: null, desk: definition.desk, input: { docs: placeholder, kind: "brief", text: step.input.text }, runId: `${definition.id}-v${definition.version}-${step.id}`, schema: "peons.request.v1", scope: [], target: { kind: "template", template: spec.template, version: spec.version } });
  if (Result.isFailure(request)) {return refuse("InputRefused", `${at} maps input docs that are not slugs: ${issuesOf(request.failure)}`, spec.inputs.map(({ doc }) => doc).join(", "));}
  const compiled = compileTemplate(loaded, request.success);
  if ("type" in compiled) {return promptOfRefused(compiled, `called workflow_define with ${at} on ${named}`);}
  const part = decodeThinkPart(compiled.plan);
  const think = Result.isSuccess(part) ? Object.values(part.success.machine.states).flatMap((state) => { const decoded = decodeThinkState(state); return decoded._tag === "Some" ? [decoded.value.meta.step] : []; })[0] : undefined;
  if (Result.isFailure(part) || think === undefined)
    {return refuse("PlanShapeRefused", `think-template.ts compile returned no think step for ${named}${Result.isFailure(part) ? `: ${issuesOf(part.failure)}` : ""}`, "a plan with defaults.agent and one think state", "call workflow_define again once think-template.ts emits that shape; ask Brains to fix it");}
  const rename: Record<string, string> = { brief: `${step.id}-brief`, ...Object.fromEntries(Object.keys(loaded.warmup).map((doc) => [doc, `${step.id}-${doc}`])), ...Object.fromEntries(Object.entries(mapped).map(([doc, source]) => [doc, docOf(source)])) };
  const text = think.prompt.replaceAll(DOC_REF, (ref, name: string) => (rename[name] === undefined ? ref : `{{docs.${rename[name]}}}`));
  const docs = { [`${step.id}-brief`]: step.input.text, ...Object.fromEntries(Object.entries(loaded.warmup).map(([doc, body]) => [`${step.id}-${doc}`, body])) };
  return {
    docs,
    frozen: { cites: Object.fromEntries(Object.entries(rename).toSorted(byKey)), profile: profileOf(loaded), route: resolved === null ? null : routeRecord(resolved), template: templateRefOf(loaded), verdict: spec.output.verdict },
    step,
    think: { agent: { ...part.success.defaults.agent, ...think.agent }, kind: "think", prompt: text, writes: step.id },
  };
};

const checkedStep = (step: WorkflowStep, earlier: readonly string[], at: string): Prompt | undefined => {
  if (!STEP_ID.test(step.id) || RESERVED.has(step.id))
    {return refuse("StepIdRefused", `${at} has an id that is not a lowercase letter then up to 23 letters or digits, or is reserved (done, rejected, input)`, "ids matching ^[a-z][a-z0-9]{0,23}$, other than done, rejected and input");}
  if (earlier.includes(step.id)) {return refuse("StepIdRefused", `${at} repeats an earlier id`, `ids not yet used: anything but ${earlier.join(", ")}`);}
  if (!oneOf(stepKinds, step.kind)) {return refuse("StepKindRefused", `${at} has kind ${JSON.stringify(step.kind)}, which workflows do not run`, stepKinds.join(", "));}
  if (step.gate !== undefined && !oneOf(gates, step.gate)) {return refuse("GateRefused", `${at} has gate ${JSON.stringify(step.gate)}`, gates.join(", "));}
  if (step.gate === "verify" && step.check === undefined) {return refuse("GateRefused", `${at} has a verify gate with no check for the judge to apply`, "a verify gate with check: \"<what a passing artifact has>\"");}
  const policy = step.failurePolicy ?? "stop";
  if (policy.startsWith("retry-once-on:"))
    {return refuse(
      "FailurePolicyRefused",
      `${at} asks for ${policy}, and Mischief cannot route a step failure by tag yet; provider transport drops (stream-closed, body-decode) resume as provider holds once Brains lands that change`,
      failurePolicies.join(", "),
      "call workflow_define({ workflow }) with failurePolicy: \"stop\" on this step",
    );}
  if (!oneOf(failurePolicies, policy)) {return refuse("FailurePolicyRefused", `${at} has failure policy ${JSON.stringify(policy)}`, failurePolicies.join(", "));}
  const sources = [...(step.input.from ?? []), ...Object.values(step.input.docs ?? {})];
  const unknown = sources.filter((name) => name !== "input" && !earlier.includes(name));
  if (unknown.length > 0) {return refuse("InputRefused", `${at} reads ${unknown.map((name) => JSON.stringify(name)).join(", ")}, which is not the workflow input or an earlier step`, ["input", ...earlier].join(", "));}
  return undefined;
};

const plannedStep = (step: WorkflowStep, earlier: readonly string[], deps: WorkflowDeps, definition: WorkflowDefinition): Planned | Prompt => {
  const at = `step ${JSON.stringify(step.id)}`;
  const refused = checkedStep(step, earlier, at);
  if (refused !== undefined) {return refused;}

  if ((step.template === undefined) === (step.workType === undefined)) {return refuse("TargetRefused", `${at} names ${step.template === undefined ? "neither" : "both"} a template and a work type`, "exactly one of template or workType");}
  if (step.template !== undefined) {
    const loaded = findThink(deps.think, step.template);
    if (loaded === undefined) {return refuse("TemplateRefused", `${at} names template ${JSON.stringify(step.template)}, which is not a cell-ready think template in this catalog`, thinkNames(deps.think).join(", ") || "none yet");}
    return templatedStep(step, at, loaded, null, definition);
  }
  const resolved = resolveRoute(deps.routing, step.workType ?? "");
  if (resolved instanceof RouteRefused) {return refuse("RouteRefused", `${at} has work type ${JSON.stringify(resolved.workType)}, and ${resolved.reason}`, resolved.accepted.join(", "));}
  const {specialist} = resolved.route;
  if ("peon" in specialist) {
    const loaded = findThink(deps.think, specialist.peon);
    if (loaded === undefined) {return refuse("TemplateRefused", `${at} routes to ${specialist.peon}, which is not a cell-ready think template in this catalog`, thinkNames(deps.think).join(", ") || "none yet");}
    return templatedStep(step, at, loaded, resolved, definition);
  }
  if (step.input.docs !== undefined) {return refuse("InputRefused", `${at} routes to a {profile}, which declares no template inputs; it lists the docs it reads in input.from`, 'input.from: ["input" | <earlier step id>]');}
  const { profile } = specialist;
  const text = thinkPrompt({ inputs: (step.input.from ?? []).map(docOf), notes: [`Workflow ${definition.id} v${definition.version}, step ${step.id}.`], task: step.input.text, who: `You work on ${resolved.concept} with no template.` });
  return { docs: {}, frozen: { cites: {}, profile, route: routeRecord(resolved), template: null, verdict: null }, step, think: { agent: { model: profile.model, thinking: profile.thinking }, kind: "think", prompt: text, writes: step.id } };
};


const node = (step: MischiefStep, on: Record<string, string>): StateNode => ({ meta: { step }, on: Object.fromEntries(Object.entries(on).map(([event, target]) => [event, { target }])) });

const afterOf = (step: WorkflowStep, next: string): string => {
  if (step.gate === "verify") {return `${step.id}_verify`;}
  if (step.gate === "owner-approve") {return `${step.id}_ask`;}
  return next;
};

export const defineWorkflow = (raw: unknown, deps: WorkflowDeps): DefinedWorkflow | Prompt => {
  const decoded = Schema.decodeUnknownResult(WorkflowDefinition, { errors: "all", onExcessProperty: "error" })(raw);
  if (Result.isFailure(decoded)) {return refuse("WorkflowRefused", `the definition does not decode: ${issuesOf(decoded.failure)}`, ACCEPTED_SHAPE);}
  const definition = decoded.success;

  const planned: Planned[] = [];
  for (const step of definition.steps) {
    const next = plannedStep(step, planned.map(({ step: { id } }) => id), deps, definition);
    if (next instanceof Prompt) {return next;}
    planned.push(next);
  }

  const planId = `wf-${definition.id}`;
  const warmDocs = Object.fromEntries(planned.flatMap(({ docs }) => Object.entries(docs)).toSorted(byKey));

  const states: Record<string, StateNode> = {};
  const owners: Record<string, string> = {};
  const gated = planned.some(({ step }) => step.gate !== undefined);
  for (const [index, { step, think }] of planned.entries()) {
    const next = planned[index + 1]?.step.id ?? "done";
    const after = afterOf(step, next);
    states[step.id] = node(think, { done: after });
    owners[step.id] = step.id;
    if (step.gate === "verify") {
      states[`${step.id}_verify`] = node(
        { criteria: { fail: "It does not meet the check, or you cannot tell", pass: `The ${step.id} doc meets this check: ${step.check ?? ""}` }, fallback: "fail", kind: "judge", question: `Does the output of step ${step.id} meet its check?`, reads: [step.id] },
        { fail: "rejected", pass: next },
      );
      owners[`${step.id}_verify`] = step.id;
    }
    if (step.gate === "owner-approve") {
      states[`${step.id}_ask`] = node({ kind: "ask", message: `Workflow ${definition.id} v${definition.version}, step ${step.id}: approve its output (doc ${step.id})? Reply approve or reject.`, to: definition.desk, writes: `${step.id}_answer` }, { replied: `${step.id}_gate` });
      states[`${step.id}_gate`] = node({ cases: { approve: "approve", approved: "approve", yes: "approve" }, default: "reject", kind: "switch", reads: `${step.id}_answer` }, { approve: next, reject: "rejected" });
      owners[`${step.id}_ask`] = step.id;
      owners[`${step.id}_gate`] = step.id;
    }
  }
  states.done = { type: "final" };
  if (gated) {states.rejected = { type: "final" };}

  const profiles = planned.map(({ frozen }) => frozen.profile);
  const [first] = profiles;
  if (first === undefined) {return refuse("WorkflowRefused", "the workflow has no steps", ACCEPTED_SHAPE);}
  const plan: MischiefSubmission = {
    defaults: { agent: { model: first.model, thinking: first.thinking } },
    envelope: {
      maxAgents: planned.length,
      maxDepth: 1,
      maxSteps: Object.keys(states).length * 4 + 8,
      maxThinking: thinkingMax(profiles.map(({ thinking }) => thinking)),
      models: [first.model, ...[...new Set(profiles.map(({ model }) => model))].filter((model) => model !== first.model).toSorted()],
      names: planned.some(({ step }) => step.gate === "owner-approve") ? [definition.desk] : [],
      thresholds: { judge: 0.8 },
    },
    goal: `workflow ${definition.id} v${definition.version} for ${definition.desk}`,
    id: planId,
    machine: { id: planId, initial: definition.steps[0].id, states },
  };
  const errors = checkSubmission(plan, [...Object.keys(warmDocs), INPUT_DOC, FROZEN_DOC]);
  if (errors.length > 0) {return refuse("PlanRefused", `the compiled plan fails Mischief's checks: ${errors.slice(0, 3).join("; ")}`, "a definition whose plan passes checkSubmission", FIX);}

  const last = planned.at(-1);
  const steps = Object.fromEntries(planned.map(({ step, frozen }) => [step.id, frozen]));
  const body = { definition, docs: warmDocs, final: last?.step.id ?? "done", plan, states: owners, steps, writes: last?.step.id ?? "done" };
  return { schema: "peons.workflow-plan.v1", ...body, digest: sha256(canonical(body)) };
};

const runRefused = (why: string, accepted: string, fix: string) => prompt({ accepted, debug: DEBUG, did: "called workflow_run", fix, tag: "WorkflowRunRefused", why });

const inputJson = (input: PeonRequest["input"]): Schema.Json => {
  if (input.kind === "event") {return { data: input.data, event: input.name };}
  if (Object.keys(input.docs).length === 0) {return input.text;}
  return parseJson(canonical({ docs: input.docs, text: input.text }));
};

// The submit for one run of a defined workflow: the stored plan as is, with the input and the frozen
// routes seeded. A changed doc is refused by its digest, never silently re-planned.
export const workflowRun = (defined: DefinedWorkflow, request: { readonly runId: string; readonly desk: string; readonly input: PeonRequest["input"] }): Compiled | Prompt => {
  const { digest, schema: _schema, ...body } = defined;
  if (sha256(canonical(body)) !== digest) {return runRefused("the workflow doc's digest does not match its contents", "a workflow doc exactly as workflow_define wrote it", `call workflow_define({ workflow }) again with a new version`);}
  if (defined.definition.desk !== request.desk) {return runRefused(`the workflow belongs to ${defined.definition.desk}, not ${request.desk}`, defined.definition.desk, `run it from ${defined.definition.desk}, or define a copy with desk: ${JSON.stringify(request.desk)}`);}
  const errors = checkSubmission(defined.plan, [...Object.keys(defined.docs), INPUT_DOC, FROZEN_DOC]);
  if (errors.length > 0) {return runRefused(`the stored plan fails Mischief's checks: ${errors.slice(0, 3).join("; ")}`, "a plan that passes checkSubmission", "call workflow_define({ workflow }) again with a new version");}
  const frozen: Frozen = { desk: request.desk, final: defined.final, runId: request.runId, schema: "peons.frozen.v1", states: defined.states, steps: defined.steps, writes: defined.writes };
  const input = inputJson(request.input);
  const docs = Object.fromEntries(Object.entries({ ...defined.docs, [INPUT_DOC]: input, [FROZEN_DOC]: parseJson(canonical(frozen)) }).toSorted(byKey));
  return { docs, frozen, plan: defined.plan, runId: mischiefRunId(request.desk, request.runId) };
};

export const decodeDefinedWorkflow = (raw: unknown) => {
  const decoded = Schema.decodeUnknownResult(DefinedWorkflow, { errors: "all", onExcessProperty: "error" })(raw);
  return Result.isFailure(decoded) ? runRefused(`the workflow doc does not decode: ${issuesOf(decoded.failure)}`, "a peons.workflow-plan.v1 doc written by workflow_define", "call workflow_define({ workflow }) again") : decoded.success;
};

