import { Result,Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { describe, expect, it } from "vitest";

import { FROZEN_DOC, INPUT_DOC, Prompt, checkSubmission, decodeSubmission, parseJson } from "../src/compile.ts";
import { DefinedWorkflow, defineWorkflow, workflowRun } from "../src/workflow.ts";
import type { WorkflowDeps } from "../src/workflow.ts";
import { DESK, bool, catalog, fakeHost, forAll, int, memoryFiles, pick, run, toolsWith } from "./support.ts";

const StepGen = Arbitrary.all({ concept: pick("work", "scan", "gather", "review", "ask", "docs"), fromEarlier: int(0, 3), fromInput: bool, gate: pick("none", "verify", "owner-approve"), target: pick("fix-review", "fix-ask@2", "work-type") });
const Workflows = Arbitrary.all({ steps: Arbitrary.array(StepGen, { maxLength: 4, minLength: 1 }), version: int(1, 5) });
interface StepG { readonly target: string; readonly concept: string; readonly gate: string; readonly fromInput: boolean; readonly fromEarlier: number }

const deps = { routing: catalog.routing, think: catalog.think };

// A {profile} step lists the docs it reads; a templated step maps each declared input to a source.
const templateOf = (step: StepG) => {
  if (step.target !== "work-type") {return step.target.split("@")[0];}
  if (step.concept === "review") {return "fix-review";}
  return step.concept === "ask" ? "fix-ask" : null;
};

const inputOf = (step: StepG, index: number) => {
  const sources = [...(step.fromInput || index === 0 ? ["input"] : []), ...Array.from({ length: Math.min(step.fromEarlier, index) }, (_, earlier) => `s${earlier}`)];
  const first = sources[0] ?? "input";
  const template = templateOf(step);
  if (template === "fix-review") {return { docs: { subject: first, ...(sources[1] === undefined ? {} : { criteria: sources[1] }) }, text: `Step ${index}.` };}
  if (template === "fix-ask") {return { docs: { evidence: first, ...(sources[1] === undefined ? {} : { context: sources[1] }) }, text: `Step ${index}.` };}
  return { from: sources, text: `Step ${index}.` };
};

const definitionOf = (g: { readonly steps: readonly StepG[]; readonly version: number }, kind = "peon") => ({
  desk: DESK,
  id: "measure-tick",
  schema: "peons.workflow.v1",
  steps: g.steps.map((step, index) => ({
    id: `s${index}`,
    kind,
    ...(step.target === "work-type" ? { workType: step.concept } : { template: step.target }),
    input: inputOf(step, index),
    ...(step.gate === "none" ? {} : { gate: step.gate }),
    ...(step.gate === "verify" ? { check: "it names three gates" } : {}),
  })),
  version: g.version,
});

type Define = (raw: unknown, deps: WorkflowDeps) => DefinedWorkflow | Prompt;

const isRefusal = (out: unknown, tag: string, accepted: string) =>
  out instanceof Prompt && out.tag === tag && out.message.split("\n").map((line) => line.split(":")[0]).join(",") === `${tag},Accepted,Fix,Debug` && out.accepted.includes(accepted);

const workflowsDecode = async (define: Define) =>
  await forAll(Workflows, (g) => {
    const defined = define(definitionOf(g), deps);
    if (defined instanceof Prompt) {return false;}
    const decoded = decodeSubmission(parseJson(JSON.stringify(defined.plan)));
    if (Result.isFailure(decoded) || checkSubmission(decoded.success, [...Object.keys(defined.docs), INPUT_DOC, FROZEN_DOC]).length > 0) {return false;}
    if (!Schema.is(DefinedWorkflow)(parseJson(JSON.stringify(defined)))) {return false;}
    const submit = workflowRun(defined, { desk: DESK, input: { docs: {}, kind: "brief", text: "main at f4ff64e" }, runId: "tick-15" });
    return !(submit instanceof Prompt) && submit.docs[INPUT_DOC] === "main at f4ff64e";
  });

// A define that overwrites fields on every step first, to plant a lenient implementation.
const patchingSteps = (patch: Readonly<Record<string, unknown>>): Define => (raw, known) => {
  const def = typeof raw === "object" && raw !== null && "steps" in raw && Array.isArray(raw.steps) ? { ...raw, steps: raw.steps.map((step: unknown) => (typeof step === "object" && step !== null ? { ...step, ...patch } : step)) } : raw;
  return defineWorkflow(def, known);
};

const UnknownKinds = Arbitrary.all({ kind: Arbitrary.schema(Schema.String).pipe(Arbitrary.filter((kind) => kind !== "peon")), template: Arbitrary.schema(Schema.String).pipe(Arbitrary.filter((name) => !name.startsWith("fix-review") && !name.startsWith("fix-ask"))) });

const unknownRefuses = async (define: Define) =>
  await forAll(UnknownKinds, ({ kind, template }) => {
    const base = { steps: [{ concept: "work", fromEarlier: 0, fromInput: true, gate: "none", target: "fix-review" }], version: 1 };
    const badKind = define(definitionOf(base, kind), deps);
    const raw = definitionOf(base);
    const badTemplate = define({ ...raw, steps: raw.steps.map((step) => ({ ...step, template })) }, deps);
    return isRefusal(badKind, "StepKindRefused", "peon") && isRefusal(badTemplate, "TemplateRefused", "fix-ask@2, fix-review@1");
  });

describe("workflow_define", () => {
  it("every generated workflow compiles to one plan that decodes as a Mischief plan and passes its checks", async () => {
    expect(await workflowsDecode(defineWorkflow)).toBeUndefined();
  });

  it("refuses an unknown step kind or template, naming the accepted ones", async () => {
    expect(await unknownRefuses(defineWorkflow)).toBeUndefined();
  });

  it("plant: accepting an unknown kind fails the property", async () => {
    expect(await unknownRefuses(patchingSteps({ kind: "peon" }))).toBeDefined();
  });

  it("freezes each step's route into the plan and compiles gates to Mischief states", () => {
    const defined = defineWorkflow(
      { desk: DESK, id: "measure-tick", schema: "peons.workflow.v1", steps: [{ gate: "owner-approve", id: "gather", input: { from: ["input"], text: "Gather counts." }, kind: "peon", workType: "scan" }, { check: "every number has a command", gate: "verify", id: "judge", input: { docs: { subject: "gather" }, text: "Read them." }, kind: "peon", workType: "review" }], version: 1 },
      deps,
    );
    if (defined instanceof Prompt) {throw new TypeError(defined.message);}
    expect(Object.keys(defined.plan.machine.states)).toEqual(["gather", "gather_ask", "gather_gate", "judge", "judge_verify", "done", "rejected"]);
    expect(defined.steps.gather).toMatchObject({ route: { concept: "scan", tableVersion: 3 }, template: null, verdict: null });
    expect(defined.steps.judge).toMatchObject({ cites: { brief: "judge-brief", rules: "judge-rules", subject: "gather" }, route: { concept: "review" }, template: { template: "fix-review", version: 1 }, verdict: "peons.verdict.change-review.v1" });
    expect(defined.plan.envelope.names).toEqual([DESK]);
    expect(defined.plan.envelope.models).toEqual(["claude-bridge/claude-haiku-5-5", "sol"]);
    expect("version" in defined.plan).toBe(false);
  });

  it("takes a templated step's think from think-template.ts with its docs renamed, so two steps on one template never share a doc", () => {
    const defined = defineWorkflow(
      { desk: DESK, id: "two-asks", schema: "peons.workflow.v1", steps: [{ id: "first", input: { docs: { evidence: "input" }, text: "One." }, kind: "peon", template: "fix-ask" }, { id: "second", input: { docs: { context: "input", evidence: "first" }, text: "Two." }, kind: "peon", template: "fix-ask" }], version: 1 },
      deps,
    );
    if (defined instanceof Prompt) {throw new TypeError(defined.message);}
    const prompts = ["first", "second"].map((name) => { const node = defined.plan.machine.states[name]; return node !== undefined && "meta" in node && node.meta !== undefined && "step" in node.meta && node.meta.step.kind === "think" ? node.meta.step.prompt : ""; });
    expect(prompts.map((text) => [...text.matchAll(/\{\{docs\.(?<name>[a-z0-9_-]+)\}\}/gu)].map((match) => match[1]))).toEqual([["first-rules", "first-brief", INPUT_DOC], ["second-rules", "second-brief", "first", INPUT_DOC]]);
    expect(Object.keys(defined.docs)).toEqual(["first-brief", "first-rules", "second-brief", "second-rules"]);
    expect(defined.docs["first-rules"]).toBe("Ask rules.");
  });

  it("refuses a templated step whose mapping think-template.ts refuses, with its four lines", () => {
    const missing = defineWorkflow({ desk: DESK, id: "x", schema: "peons.workflow.v1", steps: [{ id: "a", input: { docs: { context: "input" }, text: "t" }, kind: "peon", template: "fix-ask" }], version: 1 }, deps);
    expect(isRefusal(missing, "MissingInput", "evidence")).toBe(true);
    const listed = defineWorkflow({ desk: DESK, id: "x", schema: "peons.workflow.v1", steps: [{ id: "a", input: { from: ["input"], text: "t" }, kind: "peon", template: "fix-ask" }], version: 1 }, deps);
    expect(isRefusal(listed, "InputRefused", "evidence")).toBe(true);
  });
});

const policyRefused = async (define: Define) =>
  await forAll(pick("stream-closed", "body-decode", "step-failed", "x"), (tag) => {
    const raw = definitionOf({ steps: [{ concept: "work", fromEarlier: 0, fromInput: true, gate: "none", target: "fix-review" }], version: 1 });
    const out = define({ ...raw, steps: raw.steps.map((step) => ({ ...step, failurePolicy: `retry-once-on:${tag}` })) }, deps);
    return isRefusal(out, "FailurePolicyRefused", "stop") && out instanceof Prompt && out.fix.includes('failurePolicy: "stop"') && out.why.includes("by tag");
  }, 20);

describe("failure policy", () => {
  it("accepts stop and refuses retry-once-on:<tag> with a 4-line prompt until Mischief routes failures by tag", async () => {
    expect(await policyRefused(defineWorkflow)).toBeUndefined();
  });

  it("plant: accepting retry-once-on fails the refusal property", async () => {
    expect(await policyRefused(patchingSteps({ failurePolicy: "stop" }))).toBeDefined();
  });
});

describe("workflow tools", () => {
  it("writes a versioned workflow doc once, refuses a changed body under the same version, and runs it idempotently", async () => {
    const fake = fakeHost();
    const { files, store } = memoryFiles();
    const tools = toolsWith(fake.host, files);
    const workflow = definitionOf({ steps: [{ concept: "scan", fromEarlier: 0, fromInput: true, gate: "none", target: "work-type" }, { concept: "work", fromEarlier: 1, fromInput: false, gate: "none", target: "fix-review" }], version: 1 });
    const defined = await run(tools.workflow_define({ workflow }));
    expect(defined.isError).toBe(false);
    expect([...store.keys()]).toEqual(["/work/.peons/workflows/measure-tick/v1.json"]);
    const unchanged = await run(tools.workflow_define({ workflow }));
    expect(unchanged.text).toContain("unchanged");
    const changed = await run(tools.workflow_define({ workflow: { ...workflow, steps: workflow.steps.map((step) => ({ ...step, input: { ...step.input, text: "Other." } })) } }));
    expect(changed.text.split("\n")[0]).toMatch(/^WorkflowVersionTaken: /u);
    const first = await run(tools.workflow_run({ brief: "main at f4ff64e", runId: "tick-15", workflow: ".peons/workflows/measure-tick/v1.json" }));
    const again = await run(tools.workflow_run({ brief: "main at f4ff64e", runId: "tick-15", workflow: ".peons/workflows/measure-tick/v1.json" }));
    expect(first.data).toMatchObject({ result: { status: "running" } });
    expect(again.data).toEqual(first.data);
    expect(fake.calls.submit.length).toBe(1);
  });
});
