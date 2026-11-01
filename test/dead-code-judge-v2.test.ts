import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { Prompt, checkSubmission, compileRun } from "../src/compile.ts";
import type { MischiefSubmission, StateNode, ThinkStep } from "../src/compile.ts";
import { PeonRefused, WORKSPACE_TOOLS } from "../src/contract.ts";
import { decodeVerdict } from "../src/run-report.ts";
import { compile, loadTemplate } from "../src/think-template.ts";
import { quotesOf } from "../src/verdicts.ts";
import { DESK } from "./support.ts";

const template = loadTemplate(new URL("../templates/dead-code-judge/v2", import.meta.url).pathname);
const checkout = { repo: "badass-courses/drovr", sha: "0123456789abcdef0123456789abcdef01234567" };
const batch = [{ id: "src/a.ts#unused" }, { id: "scripts/old.ts" }];
const docs = { batch: JSON.stringify(batch) };
const request = { base: null, checkout, desk: DESK, input: { docs, kind: "brief" as const, text: "Judge these ids" }, runId: "dead-code-v2", schema: "peons.request.v1" as const, scope: [], target: { kind: "template" as const, template: "dead-code-judge", version: 2 } };
const name = "peons.verdict.dead-code.v2";

const thinkSteps = (plan: MischiefSubmission): (typeof ThinkStep.Type)[] =>
  Object.values(plan.machine.states).flatMap((node: StateNode): (typeof ThinkStep.Type)[] => {
    if ("type" in node || "states" in node) {return [];}
    const { step } = node.meta;
    return step.kind === "think" ? [step] : [];
  });

const grep = { command: "grep -rn unused /work --exclude-dir=.brain | grep -v '^/work/src/a.ts:12:'", output: "" };
const fileGrep = { command: "grep -rn old /work | grep -v '^/work/scripts/old.ts:'", output: "" };
const item = (id: string, verdict: string, searches: readonly { command: string; output: string }[]) => ({
  confidence: "high",
  id,
  proof: [{ at: id === "src/a.ts#unused" ? "src/a.ts:12" : "scripts/old.ts:1", quote: id === "src/a.ts#unused" ? "export const unused = 1;" : "#!/usr/bin/env node" }],
  searches,
  testFilesCoveringOnlyIt: [],
  verdict,
});
const output = (first: ReturnType<typeof item>, second = item("scripts/old.ts", "dead", [fileGrep])) => ({ items: [first, second], schema: name });
const ok = (value: Schema.Json) => decodeVerdict(name, value, docs).ok;

describe("dead-code-judge@2", () => {
  it("compiles with a checkout into the five workspace tools, the /work note and the envelope tools", () => {
    expect(template.spec).toMatchObject({ kind: "judge", owner: "agent-graph/desk", profile: { model: "opus", thinking: "medium" }, workspace: "checkout" });
    expect(template.spec.inputs.map((input) => [input.doc, input.required])).toEqual([["batch", true], ["rules", false]]);
    const compiled = compileRun(request, null, template);
    if (compiled instanceof Prompt) {throw new TypeError(compiled.message);}
    const { plan } = compiled;
    expect(plan.defaults.agent.workspace).toEqual(checkout);
    expect(plan.defaults.agent.tools).toEqual([...WORKSPACE_TOOLS]);
    expect(plan.envelope.tools).toEqual(expect.arrayContaining([...WORKSPACE_TOOLS]));
    const steps = thinkSteps(plan);
    expect(steps).toHaveLength(1);
    expect(steps.every((step) => step.prompt.includes("mounted at /work") && step.prompt.includes("/work is read-only") && step.prompt.includes("/tmp"))).toBe(true);
    expect(checkSubmission(plan, Object.keys(compiled.docs))).toEqual([]);
  });

  it("refuses a request without a checkout, and the v1 evidence doc", () => {
    const { checkout: _dropped, ...bare } = request;
    const refused = compileRun(bare, null, template);
    expect(refused).toBeInstanceOf(Prompt);
    expect(refused instanceof Prompt && refused.message).toContain("checkout");
    expect(compile(template, { ...request, input: { ...request.input, docs: { ...docs, evidence: "pasted grep" } } })).toMatchObject({ tag: "UnknownInput" });
    expect(Schema.is(PeonRefused)(compile(template, request))).toBe(false);
  });

  it("accepts a dead verdict with its definition path:line and an empty search over /work", () => {
    expect(ok(output(item("src/a.ts#unused", "dead", [grep])))).toBe(true);
    for (const label of ["live", "unsure", "drop-export"]) {
      expect(ok(output(item("src/a.ts#unused", label, [])))).toBe(true);
    }
    const decoded = decodeVerdict(name, output(item("src/a.ts#unused", "dead", [grep])), docs);
    // /work quotes are not run docs, so the doc quote check has nothing to hold them against.
    expect(decoded.ok && quotesOf(decoded.verdict)).toEqual([]);
  });

  it("refuses a dead verdict without a grep command over /work that printed nothing", () => {
    expect(ok(output(item("src/a.ts#unused", "dead", [])))).toBe(false);
    expect(ok(output(item("src/a.ts#unused", "dead", [{ ...grep, output: "/work/src/b.ts:3:unused()" }])))).toBe(false);
    expect(ok(output(item("src/a.ts#unused", "dead", [{ command: "grep -rn unused src", output: "" }])))).toBe(false);
    expect(ok(output(item("src/a.ts#unused", "dead", [{ command: "grep -rn other /work", output: "" }])))).toBe(false);
  });

  it("refuses a dead search that leaves out tests or fixtures, since those count as use", () => {
    for (const exclude of ["--exclude-dir=test", "--exclude-dir=__tests__", "--exclude='*.test.*'", "--exclude='*.spec.*'", "--exclude-dir=fixtures", "| grep -v test/"]) {
      expect(ok(output(item("src/a.ts#unused", "dead", [{ ...grep, command: `${grep.command} ${exclude}` }]))), exclude).toBe(false);
    }
    // A definition under test/ may name its own path while excluding its line.
    const own = { confidence: "high", id: "test/helpers.ts#unusedHelper", proof: [{ at: "test/helpers.ts:4", quote: "export const unusedHelper = 1;" }], searches: [{ command: "grep -rn unusedHelper /work | grep -v '^/work/test/helpers.ts:4:'", output: "" }], testFilesCoveringOnlyIt: [], verdict: "dead" };
    expect(decodeVerdict(name, { items: [own], schema: name }, { batch: JSON.stringify([{ id: own.id }]) }).ok).toBe(true);
  });

  it("refuses dead and drop-export proof that is not tied to the item, and ids off the batch", () => {
    const loose = { ...item("src/a.ts#unused", "dead", [grep]), proof: [{ at: "src/b.ts:1", quote: "import x from 'y';" }] };
    expect(ok(output(loose))).toBe(false);
    expect(ok(output({ ...loose, verdict: "drop-export" }))).toBe(false);
    expect(ok(output({ ...item("src/a.ts#unused", "dead", [grep]), proof: [{ at: "xsrc/a.ts:12", quote: "export const x = 1;" }] }))).toBe(false);
    expect(ok({ items: [item("src/a.ts#unused", "dead", [grep])], schema: name })).toBe(false);
    expect(ok(output({ ...item("src/a.ts#unused", "dead", [grep]), proof: [{ at: "src/a.ts", quote: "export const unused = 1;" }] }))).toBe(false);
  });
});
