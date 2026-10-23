// A peon request becomes one Mischief plan, with one compiler per shape. A {profile} route compiles
// here: one think step on the route's model and thinking, with the request's input seeded as docs and
// writes naming the artifact doc. A {peon} route or a template target compiles through
// think-template.ts (Brains's), whose output must decode as a Mischief plan exactly as emitted. Either
// way the route is frozen at compile: the plan carries the profile, and the peon-frozen doc carries the
// route record, so a resumed run never switches models and a record rebuilds from the run alone. Compile is pure and byte-deterministic: no clock, no random ids,
// and every record it builds is keyed in sorted order, so a resubmit under the same runId is the same
// body.
//
// MischiefSubmission is derived from mischief/packages/core/src/plans/schema.ts and checkSubmission from
// plans/validate.ts and plans/doc-refs.ts, because @mischief/core is not a dependency here. The host's
// validatePlan stays the authority: this copy catches what a plan author can fix before submit.
import { createHash } from "node:crypto";

import { Result, Schema, SchemaIssue } from "effect";

import { PeonRefused, PeonRequest, Profile, Route as RecordRoute, TemplateRef } from "./contract.ts";
import type { Resolved } from "./routing.ts";
import { routeRecord } from "./routing.ts";
import { byKey, compile as compileTemplate, mischiefRunId } from "./think-template.ts";
import type { LoadedTemplate } from "./think-template.ts";
import { VerdictName } from "./verdicts.ts";

// ---------------------------------------------------------------------------------------------
// The 4-line prompt every refusal uses.

export class Prompt extends Schema.TaggedError<Prompt>()("Prompt", {
  accepted: Schema.String,
  debug: Schema.String,
  did: Schema.String,
  fix: Schema.String,
  tag: Schema.String,
  why: Schema.String,
}) {
  override get message(): string {
    return [`${this.tag}: you ${this.did}, and it failed because ${this.why}`, `Accepted: ${this.accepted}`, `Fix: ${this.fix}`, `Debug: ${this.debug}`].join("\n");
  }
}

export const prompt = (fields: { tag: string; did: string; why: string; accepted: string; fix: string; debug: string }) => new Prompt(fields);

// Paths and expectations only: Effect's Standard Schema formatter never echoes the input value.
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();
export const issuesOf = (error: Schema.SchemaError, limit = 4): string => {
  const {issues} = formatIssues(error.issue);
  const pathText = (issue: (typeof issues)[number]) => {
    const text = issue.path?.map(String).join(".") ?? "";
    return text === "" ? "(root)" : text;
  };
  const shown = issues.slice(0, limit).map((issue) => `${pathText(issue)}: ${issue.message}`);
  return [...shown, ...(issues.length > limit ? [`and ${issues.length - limit} more`] : [])].join("; ");
};

// ---------------------------------------------------------------------------------------------
// Canonical JSON and content digests.

export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {return `[${value.map(canonical).join(",")}]`;}
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, field]) => field !== undefined).toSorted(byKey);
    return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

const sorted = <A>(record: Readonly<Record<string, A>>): Record<string, A> =>
  Object.fromEntries(Object.entries(record).toSorted(byKey));

// ---------------------------------------------------------------------------------------------
// MischiefSubmission, derived from mischief/packages/core/src/plans/schema.ts: PlanSchema without
// version, which runs/submission.ts checkSubmission stamps as 1 at submit. A body that carries version
// is refused here, because Mischief would overwrite it without a word.

const Probability = Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 }));
const Count = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const StateKey = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,31}$/u));
const EventName = Schema.String.check(Schema.isPattern(/^(?:[a-z][a-z0-9_-]{0,31}|xstate\.done\.state\.[a-z0-9_.-]+)$/u));
export const DocKey = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/u));
export const RatKingName = Schema.String.check(Schema.isPattern(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z][a-z0-9_-]{0,31}$/u));
// Mischief's gateway aliases (GATEWAY_MODELS in mischief packages/thinking/src/gateway.ts), or a
// provider/model ref.
export const GATEWAY_MODELS = ["sol", "luna", "gpt-6-luna", "gpt-6.1-sol"] as const;
const ModelRef = Schema.Union([Schema.Literals(GATEWAY_MODELS), Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/u))]);
const ToolName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/u));
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const Thinking = Schema.Literals(thinkingLevels);
const CapabilityName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/u));
export const PlanId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/u));

const Envelope = Schema.Struct({
  extensions: Schema.optionalKey(Schema.Array(ToolName)),
  maxAgents: Count,
  maxDepth: Count,
  maxSteps: Count,
  maxThinking: Thinking,
  models: Schema.NonEmptyArray(ModelRef),
  names: Schema.Array(RatKingName),
  skills: Schema.optionalKey(Schema.Array(ToolName)),
  thresholds: Schema.Struct({ judge: Probability, think: Schema.optionalKey(Probability) }),
  tools: Schema.optionalKey(Schema.Array(ToolName)),
});
const Placement = Schema.Union([Schema.Literal("child"), Schema.Struct({ name: RatKingName })]);
export const AgentConfig = Schema.Struct({
  extensions: Schema.optionalKey(Schema.Array(ToolName)),
  model: Schema.optionalKey(ModelRef),
  placement: Schema.optionalKey(Placement),
  skills: Schema.optionalKey(Schema.Array(ToolName)),
  thinking: Schema.optionalKey(Thinking),
  tools: Schema.optionalKey(Schema.Array(ToolName)),
});
export const ThinkStep = Schema.Struct({
  agent: Schema.optionalKey(AgentConfig),
  ephemeral: Schema.optionalKey(Schema.Struct({ capability: CapabilityName, input: Schema.optionalKey(Schema.Json), reads: Schema.optionalKey(Schema.Array(DocKey)) })),
  kind: Schema.Literal("think"),
  post: Schema.optionalKey(Schema.Struct({ capability: CapabilityName })),
  prompt: Schema.String,
  writes: Schema.optionalKey(DocKey),
});
const Criterion = Schema.Union([
  Schema.String.check(Schema.isNonEmpty()),
  Schema.Array(Schema.Json).check(Schema.isMinLength(1)),
  Schema.Record(Schema.String, Schema.Json).check(Schema.isMinProperties(1)),
]);
const JudgeStep = Schema.Struct({
  criteria: Schema.optionalKey(Schema.Record(EventName, Criterion)),
  fallback: Schema.optionalKey(Schema.String),
  kind: Schema.Literal("judge"),
  question: Schema.String,
  reads: Schema.optionalKey(Schema.Array(DocKey)),
  threshold: Schema.optionalKey(Probability),
});
const SwitchStep = Schema.Struct({ cases: Schema.Record(Schema.String, EventName), default: EventName, kind: Schema.Literal("switch"), reads: DocKey });
const AskStep = Schema.Struct({ kind: Schema.Literal("ask"), message: Schema.String, to: RatKingName, writes: Schema.optionalKey(DocKey) });
const AskJoelStep = Schema.Struct({ kind: Schema.Literal("ask-joel"), question: Schema.String });
const SketchStep = Schema.Struct({ goal: Schema.String, kind: Schema.Literal("sketch"), next: StateKey });
const CallStep = Schema.Struct({
  capability: CapabilityName,
  input: Schema.optionalKey(Schema.Json),
  kind: Schema.Literal("call"),
  reads: Schema.optionalKey(Schema.Array(DocKey)),
  writes: Schema.optionalKey(DocKey),
});
const Transitions = Schema.Record(EventName, Schema.Struct({ target: StateKey }));
const FinalState = Schema.Struct({ type: Schema.Literal("final") });
const BranchStep = Schema.Union([CallStep, ThinkStep, AskStep, JudgeStep, SwitchStep]);
const Branch = Schema.Struct({
  initial: StateKey,
  states: Schema.Record(StateKey, Schema.Union([FinalState, Schema.Struct({ meta: Schema.Struct({ step: BranchStep }), on: Transitions })])),
});
const ParallelStep = Schema.Struct({ branches: Schema.Record(StateKey, Branch), join: Schema.Literals(["allSettled", "failFast"]), kind: Schema.Literal("parallel") });
const Step = Schema.Union([ThinkStep, JudgeStep, SwitchStep, AskStep, AskJoelStep, SketchStep, ParallelStep, CallStep]);
const StepState = Schema.Struct({ meta: Schema.Struct({ step: Step }), on: Schema.optionalKey(Transitions) });

type StepStateT = typeof StepState.Type;
export type MischiefStep = typeof Step.Type;
interface CompoundState {
  readonly description?: string;
  readonly initial: string;
  readonly meta?: { readonly elaboratedFrom: typeof SketchStep.Type; readonly version: number };
  readonly on?: typeof Transitions.Type;
  readonly states: Readonly<Record<string, StateNode>>;
}
export type StateNode = typeof FinalState.Type | StepStateT | CompoundState;

const CompoundStateSchema: Schema.Codec<CompoundState> = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  initial: StateKey,
  meta: Schema.optionalKey(Schema.Struct({ elaboratedFrom: SketchStep, version: Count })),
  on: Schema.optionalKey(Transitions),
  states: Schema.Record(StateKey, Schema.suspend((): Schema.Codec<StateNode> => StateNodeSchema)),
});
const StateNodeSchema: Schema.Codec<StateNode> = Schema.Union([FinalState, StepState, CompoundStateSchema]);

export const MischiefSubmission = Schema.Struct({
  defaults: Schema.Struct({ agent: AgentConfig, placement: Schema.optionalKey(Placement) }),
  envelope: Envelope,
  goal: Schema.optionalKey(Schema.String),
  id: PlanId,
  machine: Schema.Struct({ id: PlanId, initial: StateKey, states: Schema.Record(StateKey, StateNodeSchema) }),
});
export type MischiefSubmission = typeof MischiefSubmission.Type;

export const decodeSubmission = Schema.decodeUnknownResult(MischiefSubmission, { errors: "all", onExcessProperty: "error" });

// ---------------------------------------------------------------------------------------------
// checkSubmission, derived from plans/validate.ts and plans/doc-refs.ts.

const BASE_TOOLS = ["plan-docs.read", "plan-docs.write", "report", "ask-parent"];
export const DOC_REF = /\{\{docs\.(?<name>[a-z][a-z0-9_-]{0,63})\}\}/gu;
export const docRefs = (text: string) => [...text.matchAll(DOC_REF)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

const isFinal = (node: StateNode): node is typeof FinalState.Type => "type" in node;
const isCompound = (node: StateNode): node is CompoundState => "states" in node;

interface Placed { readonly step: MischiefStep; readonly on: typeof Transitions.Type | undefined; readonly where: string; readonly depth: number; readonly siblings: readonly string[] }

const placedSteps = (states: Readonly<Record<string, StateNode>>, path: readonly string[] = []): Placed[] =>
  Object.entries(states).flatMap(([name, node]): Placed[] => {
    const where = [...path, name];
    if (isFinal(node)) {return [];}
    if (isCompound(node)) {return placedSteps(node.states, where);}
    return [{ depth: where.length, on: node.on, siblings: Object.keys(states), step: node.meta.step, where: where.join(".") }];
  });

const findCode = (value: unknown, path: string): string[] => {
  if (Array.isArray(value)) {return value.flatMap((child, index) => findCode(child, `${path}.${index}`));}
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => (key === "@code" || key === "@expr" ? [`${path}.${key}: plans are data, so @code and @expr are refused`] : findCode(child, `${path}.${key}`)));
  }
  return [];
};

const levelNames: readonly string[] = thinkingLevels;
const rank = (level: string) => levelNames.indexOf(level);
const outside = (where: string, kind: string, used: readonly string[], allowed: readonly string[]) =>
  used.filter((name) => !allowed.includes(name)).map((name) => `${where}: ${kind} "${name}" is outside the envelope`);
const needs = (where: string, on: Placed["on"], event: string) => (on?.[event] === undefined ? [`${where}: needs on.${event}`] : []);
const targets = ({ on, siblings, where }: Placed) =>
  Object.entries(on ?? {}).filter(([, { target }]) => !siblings.includes(target)).map(([event, { target }]) => `${where}: on.${event} targets "${target}", which is not a sibling state`);

type Refs = (where: string, names: readonly string[]) => string[];
type StepOf<K extends MischiefStep["kind"]> = Extract<MischiefStep, { kind: K }>;

const thinkErrors = (plan: MischiefSubmission, step: StepOf<"think">, { on, where }: Placed, refs: Refs): string[] => {
  const { envelope } = plan;
  const agent = { ...plan.defaults.agent, ...step.agent };
  const model = agent.model ?? envelope.models[0];
  return [
    ...needs(where, on, "done"),
    ...(envelope.models.includes(model) ? [] : [`${where}: model "${model}" is outside the envelope`]),
    ...(agent.thinking !== undefined && rank(agent.thinking) > rank(envelope.maxThinking) ? [`${where}: thinking "${agent.thinking}" exceeds envelope.maxThinking "${envelope.maxThinking}"`] : []),
    ...outside(where, "tool", agent.tools ?? [], [...BASE_TOOLS, ...(envelope.tools ?? [])]),
    ...outside(where, "skill", agent.skills ?? [], envelope.skills ?? []),
    ...outside(where, "extension", agent.extensions ?? [], envelope.extensions ?? []),
    ...(step.ephemeral !== undefined || step.post !== undefined ? [`${where}: ephemeral and post need step kind "call", which is off`] : []),
    ...refs(where, docRefs(step.prompt)),
  ];
};

const judgeErrors = (step: StepOf<"judge">, { on, where }: Placed, refs: Refs): string[] => {
  const events = Object.keys(on ?? {});
  const named = Object.keys(step.criteria ?? {});
  return [
    ...(events.length < 2 ? [`${where}: judge needs at least two transitions`] : []),
    ...(step.fallback === undefined || events.includes(step.fallback) ? [] : [`${where}: fallback "${step.fallback}" is not one of its transitions`]),
    ...(step.criteria === undefined || canonical([...events].toSorted()) === canonical([...named].toSorted()) ? [] : [`${where}: criteria must name exactly its transitions`]),
    ...refs(where, step.reads ?? []),
  ];
};

const switchErrors = (step: StepOf<"switch">, { on, where }: Placed, refs: Refs): string[] => {
  const events = Object.keys(on ?? {});
  return [
    ...Object.values(step.cases).filter((option) => !events.includes(option)).map((option) => `${where}: switch case goes to "${option}", which is not one of its transitions`),
    ...(events.includes(step.default) ? [] : [`${where}: switch default "${step.default}" is not one of its transitions`]),
    ...refs(where, [step.reads]),
  ];
};

const kindErrors = (plan: MischiefSubmission, placed: Placed, refs: Refs): string[] => {
  const { step, on, where } = placed;
  const { envelope } = plan;
  switch (step.kind) {
    case "think": {
      return thinkErrors(plan, step, placed, refs);
    }
    case "ask": {
      return [...needs(where, on, "replied"), ...(envelope.names.includes(step.to) ? [] : [`${where}: Rat King name "${step.to}" is not on envelope.names`]), ...refs(where, docRefs(step.message))];
    }
    case "judge": {
      return judgeErrors(step, placed, refs);
    }
    case "switch": {
      return switchErrors(step, placed, refs);
    }
    case "ask-joel": {
      return Object.keys(on ?? {}).length < 2 ? [`${where}: ask-joel needs at least two transitions`] : [];
    }
    case "call": {
      return [`${where}: step kind "call" is off on Mischief hosts until Joel approves MISCHIEF_STEP_KINDS=call`];
    }
    case "sketch":
    case "parallel": {
      return [`${where}: peons plans do not emit ${step.kind} steps`];
    }
    default: {
      return [];
    }
  }
};

export const checkSubmission = (plan: MischiefSubmission, seeded: readonly string[]): string[] => {
  const steps = placedSteps(plan.machine.states);
  const { envelope } = plan;
  const known = new Set([...seeded, ...steps.flatMap(({ step }) => ("writes" in step && step.writes !== undefined ? [step.writes] : []))]);
  const refs: Refs = (where, names) => names.filter((name) => !known.has(name)).map((name) => `${where}: doc "${name}" is not written by any step and not seeded`);

  const errors = steps.flatMap((placed): string[] => {
    const { where, depth } = placed;
    const common = [...targets(placed), ...(depth > envelope.maxDepth ? [`${where}: nesting depth ${depth} exceeds envelope.maxDepth ${envelope.maxDepth}`] : [])];
    return [...common, ...kindErrors(plan, placed, refs)];
  });
  const agents = steps.filter(({ step }) => step.kind === "think").length;
  const initial = Object.hasOwn(plan.machine.states, plan.machine.initial) ? [] : [`machine.initial "${plan.machine.initial}" is not a state`];
  return [
    ...findCode(plan, "$"),
    ...initial,
    ...errors,
    ...(agents > envelope.maxAgents ? [`plan has ${agents} think steps, envelope.maxAgents allows ${envelope.maxAgents}`] : []),
  ];
};

// ---------------------------------------------------------------------------------------------
// What a compile freezes, seeded as the peon-frozen doc so a record rebuilds from the run alone.

export const FROZEN_DOC = "peon-frozen";
export const INPUT_DOC = "peon-input";
export const ARTIFACT_DOC = "artifact";

// template is null for a {profile} route, which runs no template; verdict names the schema a think
// template's output doc must decode with, and is null for a free-form artifact. cites maps each doc
// name the template's prompt uses to the run doc that holds it, so verifyQuotes can find a quote's
// source after a workflow renames docs.
export const FrozenStep = Schema.Struct({
  cites: Schema.Record(DocKey, DocKey),
  profile: Profile,
  route: Schema.NullOr(RecordRoute),
  template: Schema.NullOr(TemplateRef),
  verdict: Schema.NullOr(VerdictName),
});
export type FrozenStep = typeof FrozenStep.Type;

export const Frozen = Schema.Struct({
  desk: PeonRequest.fields.desk,
  final: StateKey,
  runId: PeonRequest.fields.runId,
  schema: Schema.Literal("peons.frozen.v1"),
  states: Schema.Record(StateKey, StateKey),
  steps: Schema.Record(StateKey, FrozenStep),
  writes: DocKey,
});
export type Frozen = typeof Frozen.Type;

export interface Compiled {
  readonly runId: string;
  readonly plan: MischiefSubmission;
  readonly docs: Readonly<Record<string, Schema.Json>>;
  readonly frozen: Frozen;
}

// One Mischief run id scheme for every shape: think-template.ts's, scoped to (desk, runId).
export { mischiefRunId } from "./think-template.ts";

export const nameOf = (template: string, version: number) => `${template}@${version}`;

// The think template a "<name>[@<version>]" names: an exact version, or the highest loaded.
export const findThink = (think: readonly LoadedTemplate[], wanted: string): LoadedTemplate | undefined => {
  const [name, version] = wanted.split("@");
  const named = think.filter(({ spec }) => spec.template === name);
  if (version !== undefined) {return named.find(({ spec }) => String(spec.version) === version);}
  const [newest] = named.toSorted((a, b) => b.spec.version - a.spec.version);
  return newest;
};

export const thinkNames = (think: readonly LoadedTemplate[]) => think.map(({ spec }) => nameOf(spec.template, spec.version)).toSorted();

export const templateRefOf = (loaded: LoadedTemplate): typeof TemplateRef.Type => ({ digest: loaded.digest, template: loaded.spec.template, version: loaded.spec.version });
export const profileOf = (loaded: LoadedTemplate): typeof Profile.Type => ({ model: loaded.spec.profile.model, thinking: loaded.spec.profile.thinking });

const section = (title: string, docs: readonly string[]) =>
  docs.length === 0 ? [] : [title, ...docs.map((name) => `<doc name="${name}">\n{{docs.${name}}}\n</doc>`)];

export const thinkPrompt = (parts: {
  readonly who: string;
  readonly inputs: readonly string[];
  readonly notes: readonly string[];
  readonly task: string;
}) =>
  [
    `You are a peon: one request in, one artifact out. ${parts.who}`,
    ...section("Input:", parts.inputs),
    ...parts.notes,
    parts.task,
    "Answer with the artifact itself: the run records your answer as the artifact. If you cannot go on without a decision, ask with ask-parent and wait for the answer.",
  ].join("\n\n");

type Level = (typeof Profile.Type)["thinking"];
const lowest: Level = "off";
export const thinkingMax = (levels: readonly Level[]): Level => {
  let top: Level = lowest;
  for (const level of levels) {
    if (thinkingLevels.indexOf(level) > thinkingLevels.indexOf(top)) {top = level;}
  }
  return top;
};

const compileRefused = (why: string, accepted: string, fix: string, debug = "read src/compile.ts in joelhooks/peons") =>
  prompt({ accepted, debug, did: "asked to compile a peon plan", fix, tag: "CompileRefused", why });

const inputDocs = (input: PeonRequest["input"]): { docs: Record<string, Schema.Json>; names: string[] } => {
  if (input.kind === "event") {return { docs: { [INPUT_DOC]: { data: input.data, event: input.name } }, names: [INPUT_DOC] };}
  const extra = sorted(Object.fromEntries(Object.entries(input.docs).map(([name, text]) => [`brief-${name}`, text])));
  return { docs: { [INPUT_DOC]: input.text, ...extra }, names: [INPUT_DOC, ...Object.keys(extra)] };
};

export const parseJson: (text: string) => Schema.Json = Schema.decodeSync(Schema.fromJsonString(Schema.Json));

const frozenDoc = (frozen: Frozen): Schema.Json => parseJson(canonical(frozen));

// A {profile} route: one think step on the route's model and thinking, with no template.
export const compilePeonPlan = (request: PeonRequest, resolved: Resolved): Compiled | Prompt => {
  const { specialist } = resolved.route;
  if (!("profile" in specialist))
    {return compileRefused(`the route for ${resolved.concept} names template ${specialist.peon}, which compiles through think-template.ts`, "a {profile} route", "call compileRun(request, resolved, loadedTemplate)");}
  if (request.target.kind !== "work-type") {return compileRefused("a template target has no {profile} route", "a work-type target with its resolved {profile} route", "call compileRun(request, null, loadedTemplate)");}
  const { profile } = specialist;
  const input = inputDocs(request.input);
  const frozen: Frozen = {
    desk: request.desk,
    final: "work",
    runId: request.runId,
    schema: "peons.frozen.v1",
    states: { work: "work" },
    steps: { work: { cites: {}, profile, route: routeRecord(resolved), template: null, verdict: null } },
    writes: ARTIFACT_DOC,
  };
  const docs: Record<string, Schema.Json> = sorted({ ...input.docs, [FROZEN_DOC]: frozenDoc(frozen) });
  const notes = [
    ...(request.base === null ? [] : [`Base: ${request.base.repo} at ${request.base.sha}.`]),
    ...(request.scope.length === 0 ? [] : [`Scope: ${request.scope.join(", ")}.`]),
  ];
  const runId = mischiefRunId(request.desk, request.runId);
  const plan: MischiefSubmission = {
    defaults: { agent: { model: profile.model, thinking: profile.thinking } },
    envelope: { maxAgents: 1, maxDepth: 1, maxSteps: 16, maxThinking: profile.thinking, models: [profile.model], names: [], thresholds: { judge: 0.8 } },
    goal: `peon ${resolved.concept} (route table v${resolved.tableVersion}) for ${request.desk}`,
    id: runId,
    machine: {
      id: runId,
      initial: "work",
      states: {
        done: { type: "final" },
        work: {
          meta: { step: { agent: { model: profile.model, thinking: profile.thinking }, kind: "think", prompt: thinkPrompt({ inputs: input.names, notes, task: "Do the request.", who: `You work on ${resolved.concept} with no template.` }), writes: ARTIFACT_DOC } },
          on: { done: { target: "done" } },
        },
      },
    },
  };
  return { docs, frozen, plan, runId };
};

// Brains's refusal record, as the 4-line prompt every peons refusal uses.
export const promptOfRefused = (refused: typeof PeonRefused.Type, did: string) =>
  prompt({ accepted: refused.accepted, debug: "read src/think-template.ts compile in joelhooks/peons", did, fix: refused.fix, tag: refused.tag, why: refused.debug });

const isPeonRefused = Schema.is(PeonRefused);

// The submit body of a think plan must be a Mischief plan exactly as compile emitted it. Drift in
// think-template.ts refuses here, before anything is spent, and is never filled in.
export const strictPlan = (raw: unknown, seeded: readonly string[], source: string): MischiefSubmission | Prompt => {
  if (typeof raw === "object" && raw !== null && "version" in raw)
    {return prompt({
      accepted: "a submission without version: defaults, envelope, goal?, id and machine",
      debug: "compare src/think-template.ts compile with MischiefSubmission in src/compile.ts",
      did: "asked to compile a peon plan",
      fix: `call peon_run again once ${source} drops version; ask Brains to fix it`,
      tag: "PlanShapeRefused",
      why: `${source} returned a plan that carries version, which Mischief's checkSubmission overwrites with 1, and nothing was submitted`,
    });}
  const decoded = decodeSubmission(raw);
  if (Result.isFailure(decoded))
    {return prompt({
      accepted: "a submission Mischief's PlanSchema decodes once version is stamped: defaults, envelope, goal?, id and machine",
      debug: "compare src/think-template.ts compile with MischiefSubmission in src/compile.ts",
      did: "asked to compile a peon plan",
      fix: `call peon_run again once ${source} emits that shape; ask Brains to fix it`,
      tag: "PlanShapeRefused",
      why: `${source} returned a plan that does not decode as a Mischief plan (${issuesOf(decoded.failure)}), and nothing was submitted`,
    });}
  const errors = checkSubmission(decoded.success, seeded);
  return errors.length > 0
    ? prompt({ accepted: "a plan that passes checkSubmission", debug: "read checkSubmission in src/compile.ts", did: "asked to compile a peon plan", fix: `call peon_run again once ${source} passes; ask Brains to fix it`, tag: "PlanShapeRefused", why: `${source} returned a plan that fails Mischief's checks: ${errors.slice(0, 3).join("; ")}` })
    : decoded.success;
};

// A {peon} route or a template target: think-template.ts compiles it, and the route is frozen beside.
export const compileThink = (request: PeonRequest, resolved: Resolved | null, loaded: LoadedTemplate): Compiled | Prompt => {
  const { spec } = loaded;
  const asTemplate: PeonRequest = { ...request, target: { kind: "template", template: spec.template, version: spec.version } };
  if (request.target.kind === "template" && (request.target.template !== spec.template || (request.target.version !== null && request.target.version !== spec.version)))
    {return compileRefused(`the target names ${request.target.template}${request.target.version === null ? "" : `@${request.target.version}`}, and the template given is ${spec.template}@${spec.version}`, `${spec.template}@${spec.version}`, "load the named template and compile again");}
  if (resolved !== null) {
    const { specialist } = resolved.route;
    if (!("peon" in specialist) || specialist.peon !== `${spec.template}@${spec.version}`)
      {return compileRefused(`the route for ${resolved.concept} does not name ${spec.template}@${spec.version}`, "peon" in specialist ? specialist.peon : "a {peon} route", "load the template the route names and compile again");}
  }
  const compiled = compileTemplate(loaded, asTemplate);
  if (isPeonRefused(compiled)) {return promptOfRefused(compiled, `asked ${spec.template}@${spec.version} to compile run ${JSON.stringify(request.runId)}`);}
  const plan = strictPlan(compiled.plan, Object.keys(compiled.docs), "think-template.ts compile");
  if (plan instanceof Prompt) {return plan;}
  const final = Object.keys(plan.machine.states).find((name) => name !== "done") ?? plan.machine.initial;
  const frozen: Frozen = {
    desk: request.desk,
    final,
    runId: request.runId,
    schema: "peons.frozen.v1",
    states: { [final]: final },
    steps: { [final]: { cites: sorted(Object.fromEntries(Object.keys(compiled.docs).map((name) => [name, name]))), profile: profileOf(loaded), route: resolved === null ? null : routeRecord(resolved), template: templateRefOf(loaded), verdict: spec.output.verdict } },
    writes: spec.output.doc,
  };
  return { docs: sorted({ ...compiled.docs, [FROZEN_DOC]: frozenDoc(frozen) }), frozen, plan, runId: compiled.runId };
};

// One compiler per shape: {profile} routes here, templates through think-template.ts.
export const compileRun = (request: PeonRequest, resolved: Resolved | null, loaded: LoadedTemplate | null): Compiled | Prompt => {
  if (loaded !== null) {return compileThink(request, resolved, loaded);}
  if (resolved === null) {return compileRefused("the request resolves to neither a template nor a route", "a template, or a work type with a route", "resolve the work type with resolveRoute first");}
  return compilePeonPlan(request, resolved);
};
