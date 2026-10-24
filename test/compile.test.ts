// @effect-diagnostics unstableApiUsage:off -- effect/Arbitrary is the only property-test generator; this file is the boundary
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { describe, expect, it } from "vitest";

import { PeonRequest } from "../src/contract.ts";
import { FROZEN_DOC, INPUT_DOC, MischiefSubmission, Prompt, canonical, checkSubmission, compilePeonPlan, compileRun, decodeSubmission, findThink, mischiefRunId, parseJson, strictPlan } from "../src/compile.ts";
import type { Compiled } from "../src/compile.ts";
import { RouteRefused, resolveRoute } from "../src/routing.ts";
import { compile as compileTemplate } from "../src/think-template.ts";
import { DESK, ROOT, askTemplate, bool, catalog, forAll, int, pick, reviewTemplate, routing } from "./support.ts";

const request = (fields: Partial<PeonRequest> = {}): PeonRequest =>
  Schema.decodeSync(PeonRequest)({
    base: null,
    desk: DESK,
    input: { docs: {}, kind: "brief", text: "Find the three slowest gates." },
    runId: "run-1",
    schema: "peons.request.v1",
    scope: [],
    target: { kind: "work-type", workType: "scan" },
    ...fields,
  });

// The tools' dispatch: resolve a work type, load the template a {peon} route or target names.
const compileFor = (req: PeonRequest, tableVersion = routing.version): Compiled | Prompt => {
  if (req.target.kind === "template") {return compileRun(req, null, findThink(catalog.think, `${req.target.template}@${req.target.version ?? ""}`.replace(/@$/u, "")) ?? null);}
  const resolved = resolveRoute({ ...routing, version: tableVersion }, req.target.workType);
  if (resolved instanceof RouteRefused) {throw resolved;}
  const { specialist } = resolved.route;
  return compileRun(req, resolved, "peon" in specialist ? (findThink(catalog.think, specialist.peon) ?? null) : null);
};

const stepAt = (out: Compiled, name: string) => {
  const node = out.plan.machine.states[name];
  return node !== undefined && "meta" in node && node.meta !== undefined && "step" in node.meta ? node.meta.step : undefined;
};

const compiled = (value: Compiled | Prompt): Compiled => {
  if (value instanceof Prompt) {throw new TypeError(value.message);}
  return value;
};

// A request in, generated over shape ({profile} route, {peon} route, template target), input, doc key
// order, base, scope and table version.
const Generated = Arbitrary.all({
  base: bool,
  concept: pick("work", "scan", "gather", "docs"),
  docOrder: bool,
  event: bool,
  peon: pick("review", "ask", "ask_deep"),
  runId: pick("run-1", "Run.2:x", "a/b#3", "front-desk-measure-tick-15"),
  scope: int(0, 3),
  shape: pick("profile", "peon-route", "template"),
  tableVersion: int(0, 9),
});
interface Gen { readonly runId: string; readonly shape: string; readonly concept: string; readonly peon: string; readonly event: boolean; readonly docOrder: boolean; readonly base: boolean; readonly scope: number }

const templated = (g: Gen) => g.shape !== "profile";
const docsOf = (g: Gen, reviewing: boolean) => {
  if (!templated(g)) {return { alpha: "a", beta: "b" };}
  return reviewing ? { criteria: "no regressions", subject: "diff --git a/x b/x" } : { context: "ci", evidence: "47 passed" };
};
const fromGenerated = (g: Gen) => {
  const reviewing = g.shape === "template" ? g.docOrder : g.peon === "review";
  const docs = docsOf(g, reviewing);
  const ordered = g.docOrder ? docs : Object.fromEntries(Object.entries(docs).toReversed());
  return request({
    base: g.base ? { repo: "joelhooks/peons", sha: "f4ff64e" } : null,
    input: g.event && !templated(g) ? { data: { list: [1, 2], n: 1 }, kind: "event", name: "tick" } : { docs: ordered, kind: "brief", text: "Do it." },
    runId: g.runId,
    scope: ["src", "test", "bin"].slice(0, g.scope),
    target: g.shape === "template" ? { kind: "template", template: reviewing ? "fix-review" : "fix-ask", version: reviewing ? 1 : null } : { kind: "work-type", workType: g.shape === "profile" ? g.concept : g.peon },
  });
};

const flip = (req: PeonRequest): PeonRequest => (req.input.kind === "brief" ? { ...req, input: { ...req.input, docs: Object.fromEntries(Object.entries(req.input.docs).toReversed()) } } : req);

const same = (a: Compiled, b: Compiled) => JSON.stringify(a.plan) === JSON.stringify(b.plan) && canonical(a.plan) === canonical(b.plan) && JSON.stringify(a.docs) === JSON.stringify(b.docs) && a.runId === b.runId;

const deterministic = async (compile: (req: PeonRequest, tableVersion: number) => Compiled | Prompt) =>
  await forAll(Generated, (g) => {
    const req = fromGenerated(g);
    const first = compiled(compile(req, g.tableVersion));
    const again = compiled(compile(req, g.tableVersion));
    const flipped = compiled(compile(flip(req), g.tableVersion));
    return same(first, again) && same(first, flipped);
  });

describe("compile", () => {
  it("compiles a {profile} route to one think step on the route's model and thinking, with the brief seeded and the route frozen", () => {
    const resolved = resolveRoute(routing, "scan");
    if (resolved instanceof RouteRefused) {throw resolved;}
    const out = compiled(compilePeonPlan(request(), resolved));
    expect(stepAt(out, "work")).toMatchObject({ agent: { model: "claude-bridge/claude-haiku-5-5", thinking: "low" }, kind: "think", writes: "artifact" });
    expect(out.docs[INPUT_DOC]).toBe("Find the three slowest gates.");
    expect(out.frozen.steps.work).toEqual({ cites: {}, profile: { model: "claude-bridge/claude-haiku-5-5", thinking: "low" }, route: { concept: "scan", specialist: { profile: { model: "claude-bridge/claude-haiku-5-5", thinking: "low" } }, status: "measured", tableVersion: 3 }, template: null, verdict: null });
    expect(out.docs[FROZEN_DOC]).toEqual(JSON.parse(canonical(out.frozen)));
    expect(out.runId).toBe(mischiefRunId(DESK, "run-1"));
    expect("version" in out.plan).toBe(false);
  });

  it("compiles a {peon} route through think-template.ts unchanged, and freezes the route beside it", () => {
    const req = request({ input: { docs: { subject: "diff" }, kind: "brief", text: "Safe to ship?" }, target: { kind: "work-type", workType: "review" } });
    const out = compiled(compileFor(req));
    const direct = compileTemplate(reviewTemplate, { ...req, target: { kind: "template", template: "fix-review", version: 1 } });
    if ("type" in direct) {throw new Error(direct.tag);}
    expect(canonical(out.plan)).toBe(canonical(direct.plan));
    expect(out.runId).toBe(direct.runId);
    const { [FROZEN_DOC]: frozen, ...seeded } = out.docs;
    expect(seeded).toEqual(direct.docs);
    expect(frozen).toMatchObject({ final: "peon", steps: { peon: { route: { concept: "review", specialist: { peon: "fix-review@1" }, tableVersion: 3 }, template: { digest: reviewTemplate.digest, template: "fix-review", version: 1 }, verdict: "peons.verdict.change-review.v1" } }, writes: "review" });
  });

  it("passes think-template.ts refusals through as four-line prompts", () => {
    const missing = compileFor(request({ input: { docs: {}, kind: "brief", text: "Why?" }, target: { kind: "template", template: "fix-ask", version: 2 } }));
    expect(missing instanceof Prompt && missing.message.split("\n").map((line) => line.split(":")[0])).toEqual(["MissingInput", "Accepted", "Fix", "Debug"]);
    const wrong = compileRun(request({ target: { kind: "template", template: "fix-review", version: 1 } }), null, askTemplate);
    expect(wrong instanceof Prompt && wrong.tag).toBe("CompileRefused");
    expect(compileRun(request(), null, null)).toBeInstanceOf(Prompt);
  });

  it("every compiled plan decodes as a Mischief submission and passes its checks with the seeded docs", async () => {
    const failure = await forAll(Generated, (g) => {
      const out = compiled(compileFor(fromGenerated(g), g.tableVersion));
      const decoded = decodeSubmission(parseJson(JSON.stringify(out.plan)));
      return Result.isSuccess(decoded) && checkSubmission(decoded.success, Object.keys(out.docs)).length === 0;
    });
    expect(failure).toBeUndefined();
  });

  it("compiles the same request to byte-identical plans and docs across both shapes, whatever the doc key order", async () => {
    expect(await deterministic(compileFor)).toBeUndefined();
  });

  it("plant: a timestamp in the plan fails the determinism property", async () => {
    let tick = 0;
    const stamped = (req: PeonRequest, tableVersion: number) => {
      const out = compiled(compileFor(req, tableVersion));
      tick += 1;
      return { ...out, plan: { ...out.plan, goal: `${out.plan.goal} at ${Date.now()}.${tick}` } };
    };
    expect(await deterministic(stamped)).toBeDefined();
  });
});

// The submit boundary: a submission never carries version, which Mischief stamps.
const realCompileOutput = () => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "peons-compile-"));
  const path = nodePath.join(dir, "request.json");
  writeFileSync(path, JSON.stringify({ base: null, desk: DESK, input: { docs: { subject: "diff" }, kind: "brief", text: "Safe?" }, runId: "seam-1", schema: "peons.request.v1", scope: [], target: { kind: "template", template: "change-review", version: 1 } }));
  const body: unknown = JSON.parse(execFileSync(process.execPath, [nodePath.join(ROOT, "bin/peon-compile.ts"), nodePath.join(ROOT, "templates/change-review/v1"), path], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }));
  return typeof body === "object" && body !== null && "plan" in body ? body.plan : null;
};

const RequiresVersion = Schema.Struct({ ...MischiefSubmission.fields, version: Schema.Int });

const decodesWith = (schema: Schema.Codec<unknown>) => Result.isSuccess(Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(realCompileOutput()));

const stripping = (raw: unknown) => {
  if (typeof raw !== "object" || raw === null) {return raw;}
  const { version: _version, ...rest } = { version: null, ...raw };
  return strictPlan(rest, [INPUT_DOC, FROZEN_DOC, "rules", "brief", "evidence"], "test");
};

const refusesVersion = async (boundary: (raw: unknown) => unknown) =>
  await forAll(Arbitrary.all({ shape: pick("profile", "peon-route", "template"), version: int(0, 9) }), ({ shape, version }) => {
    const out = compiled(compileFor(fromGenerated({ base: false, concept: "work", docOrder: true, event: false, peon: "ask", runId: "v-1", scope: 0, shape })));
    const refused = boundary({ ...out.plan, version });
    return refused instanceof Prompt && refused.tag === "PlanShapeRefused" && refused.why.includes("carries version");
  }, 30);

describe("submission boundary", () => {
  it("seam: a real bin/peon-compile.ts output decodes as a Mischief submission", () => {
    expect(decodesWith(MischiefSubmission)).toBe(true);
  });

  it("plant: a schema that requires version fails on a real bin/peon-compile.ts output", () => {
    expect(decodesWith(RequiresVersion)).toBe(false);
  });

  it("refuses a body that carries version before submit, with a four-line prompt", async () => {
    expect(await refusesVersion((raw) => strictPlan(raw, [INPUT_DOC, FROZEN_DOC, "rules", "brief", "evidence"], "test"))).toBeUndefined();
  });

  it("plant: filling or stripping version instead of refusing fails the property", async () => {
    expect(await refusesVersion(stripping)).toBeDefined();
  });

  it("accepts the gateway model aliases and provider/model refs, and nothing else", () => {
    const out = compiled(compileFor(request({ input: { docs: { evidence: "e" }, kind: "brief", text: "Why?" }, target: { kind: "template", template: "fix-ask", version: 2 } })));
    const withModel = (model: string) => Result.isSuccess(decodeSubmission({ ...out.plan, envelope: { ...out.plan.envelope, models: [model] } }));
    expect(["sol", "luna", "gpt-6-luna", "gpt-6.1-sol", "openai-codex/gpt-6.1-sol", "claude-bridge/claude-haiku-5-5"].map(withModel)).toEqual([true, true, true, true, true, true]);
    expect(["gpt-7", "", "Sol", "openai-codex/"].map(withModel)).toEqual([false, false, false, false]);
  });
});
