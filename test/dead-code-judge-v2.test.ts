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

// The verifier drops the definition line, a whole file's own lines and .brain docs; the command may not.
const grep = { command: "grep -rn unused /work", output: "/work/src/a.ts:12:export const unused = 1;\n/work/.brain/notes.svx:3:unused is dead\n" };
const fileGrep = { command: "rg -uu -n old /work", output: "scripts/old.ts:3:// old entry point" };
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

  it("refuses a dead verdict without a grep command over /work that found nothing but its definition", () => {
    expect(ok(output(item("src/a.ts#unused", "dead", [])))).toBe(false);
    expect(ok(output(item("src/a.ts#unused", "dead", [{ ...grep, output: `${grep.output}/work/src/b.ts:3:unused()` }])))).toBe(false);
    expect(ok(output(item("src/a.ts#unused", "dead", [{ command: "grep -rn unused src", output: "" }])))).toBe(false);
    expect(ok(output(item("src/a.ts#unused", "dead", [{ command: "grep -rn other /work", output: "" }])))).toBe(false);
    // A proof line in another file is not a definition, so it cannot hide that file's caller.
    const hidden = { ...item("src/a.ts#unused", "dead", [{ ...grep, output: `${grep.output}/work/src/b.ts:3:unused()` }]), proof: [{ at: "src/a.ts:12", quote: "export const unused = 1;" }, { at: "src/b.ts:3", quote: "unused()" }] };
    expect(ok(output(hidden))).toBe(false);
  });

  it("refuses a dead search whose command could hide a hit", () => {
    for (const command of [
      "grep -rn unused /work | grep -v unused",
      "grep -rn unused /work || true",
      "grep -rn unused /work 2>/dev/null",
      "grep -rn unused /work; true",
      "grep -rn unused /work && true",
      "grep -rn unused $(echo /work)",
      "grep -rnv unused /work",
      "grep -rn --invert-match unused /work",
      "grep -rqn unused /work",
      "grep -rn -m0 unused /work",
      "grep -rn unused /work --exclude-dir=test",
      "grep -rn unused /work --exclude-dir=__tests__",
      "grep -rn unused /work --exclude='*.spec.*'",
      "grep -rn unused /work --include='*.ts'",
      "grep -n unused /work",
      "grep -rn unused /work/src",
      "rg -n unused /work",
      "rg -uu -n unused /work -g '!fixtures'",
      "rg -uu -n unused /work --type-not ts",
      "ag unused /work",
      // Flags are an allowlist: these all could print nothing with callers present.
      "grep -rnx unused /work",
      "grep -rn --line-regexp unused /work",
      "grep -rn -f /tmp/p /work",
      "grep -rn -f /tmp/unused /work",
      // grep reads patterns from a file named unused and prints nothing.
      "grep -rn -f unused /work",
      "grep -rnf unused /work",
      "grep -rn -e unused -e other /work",
      "rg -uu -n --max-depth 1 unused /work",
      "rg -uu -n -d 1 unused /work",
      "rg -uu -n --max-depth=1 unused /work",
      "grep -rn unused /work /work/src",
      "grep -rn unused /work /tmp/copy",
      "grep -rn -- unused /work",
      // The pattern is the term itself; a longer one matches less.
      "grep -rn unused_nope /work",
      "grep -rn 'unused()' /work",
      "grep -rn -e unused; /work",
      // The one allowed tail drops only the definition line in the item's own file.
      "grep -rn unused /work | grep -v '^/work/src/a.ts:12:' | grep -v '^/work/src/b.ts'",
      "grep -rn unused /work | grep -v '^/work/src/a.ts'",
      "grep -rn unused /work | grep -v src/a.ts",
      "grep -rn unused /work | grep -v '^/work/src/a.ts:13:'",
      "grep -rn unused /work | grep -v '^/work/src/b.ts:3:'",
      "grep -rn unused /work | grep -v '^/work/src/a.ts.*'",
      "grep -rn unused /work | grep -v '^/work/src/a.ts:12:\\|unused'",
      "grep -rn unused /work | grep -v -e '^/work/src/a.ts:12:'",
      "grep -rn unused /work | grep '^/work/src/a.ts:12:'",
    ]) {
      expect(ok(output(item("src/a.ts#unused", "dead", [{ command, output: "" }]))), command).toBe(false);
    }
    for (const command of [
      "grep -rn unused /work",
      "grep -Rnw unused /work/",
      "rg -uu -n unused /work",
      "rg -n --no-ignore --hidden unused /work",
      "grep -rnwFi --binary-files=without-match -e unused /work",
      "rg -uu -nHs --word-regexp unused /work",
      "grep -rn unused /work | grep -v '^/work/src/a.ts:12:'",
      "rg -uu -n unused /work | grep -v \"src/a.ts:12:\"",
      "grep -rn unused /work | grep -v ^/work/src/a.ts:12:",
    ]) {
      expect(ok(output(item("src/a.ts#unused", "dead", [{ command, output: "" }]))), command).toBe(true);
    }
    // A definition under test/ may sit in its own output.
    const own = { confidence: "high", id: "test/helpers.ts#unusedHelper", proof: [{ at: "test/helpers.ts:4", quote: "export const unusedHelper = 1;" }], searches: [{ command: "grep -rn unusedHelper /work", output: "/work/test/helpers.ts:4:export const unusedHelper = 1;" }], testFilesCoveringOnlyIt: [], verdict: "dead" };
    expect(decodeVerdict(name, { items: [own], schema: name }, { batch: JSON.stringify([{ id: own.id }]) }).ok).toBe(true);
    // A shell character in a batch path would run on the rerun, so the tail cannot carry it.
    const hostile = { ...item("src/a.ts#unused", "dead", [{ command: "grep -rn unused /work | grep -v ^/work/src/a;id.ts:12:", output: "" }]), id: "src/a;id.ts#unused", proof: [{ at: "src/a;id.ts:12", quote: "export const unused = 1;" }] };
    expect(decodeVerdict(name, { items: [hostile], schema: name }, { batch: JSON.stringify([{ id: hostile.id }]) }).ok).toBe(false);
    // A whole file may drop all its own lines.
    expect(ok(output(item("src/a.ts#unused", "dead", [grep]), item("scripts/old.ts", "dead", [{ command: "grep -rn old /work | grep -v '^/work/scripts/old.ts'", output: "" }])))).toBe(true);
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
