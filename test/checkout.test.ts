import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { describe, expect, it } from "vitest";

import { makeTools } from "../extensions/pi/tools.ts";
import { checkSubmission } from "../src/compile.ts";
import type { MischiefSubmission, StateNode, ThinkStep } from "../src/compile.ts";
import { WORKSPACE_TOOLS } from "../src/contract.ts";
import { DESK, catalog, fakeHost, forAll, memoryFiles, run } from "./support.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const checkouts = {
  "bad-repo": { repo: "drovr", sha: SHA },
  "bad-sha": { repo: "badass-courses/drovr", sha: "0123456" },
  good: { repo: "badass-courses/drovr", sha: SHA },
  none: undefined,
} as const;
const jobs = {
  scan: { workType: "scan" },
  template: { docs: { evidence: "slice" }, peon: "fix-ask@2" },
  work: { workType: "work" },
} as const;

const Case = Schema.Struct({ checkout: Schema.Literals(["none", "good", "bad-sha", "bad-repo"]), enabled: Schema.Boolean, job: Schema.Literals(["scan", "template", "work"]), swarm: Schema.Boolean });
const arbitrary = Arbitrary.schema(Case);

const thinkSteps = (plan: MischiefSubmission): (typeof ThinkStep.Type)[] =>
  Object.values(plan.machine.states).flatMap((node: StateNode): (typeof ThinkStep.Type)[] => {
    if ("type" in node || "states" in node) {return [];}
    const { step } = node.meta;
    return step.kind === "think" ? [step] : [];
  });
const shellIn = (tools: readonly string[] | undefined) => (tools ?? []).filter((tool) => (WORKSPACE_TOOLS as readonly string[]).includes(tool));

const attempt = async ({ checkout, enabled, job, swarm }: typeof Case.Type) =>
  await run(
    Effect.gen(function* attemptGen() {
      const fake = fakeHost();
      const plans: MischiefSubmission[] = [];
      const seeded: string[][] = [];
      const host = { ...fake.host, submit: (runId: string, plan: MischiefSubmission, docs: Readonly<Record<string, Schema.Json>>) => { plans.push(plan); seeded.push(Object.keys(docs)); return fake.host.submit(runId, plan, docs); } };
      const tools = makeTools({ catalog, checkout: enabled, cwd: "/work", desk: Effect.succeed(DESK), files: memoryFiles().files, host: Effect.succeed(host) });
      const given = { brief: "Find dead code.", ...jobs[job], ...(checkouts[checkout] === undefined ? {} : { checkout: checkouts[checkout] }) };
      const out = swarm ? yield* tools.peon_swarm({ jobs: [given] }) : yield* tools.peon_run(given);
      return { out, plans, seeded };
    }),
  );

describe("checkout", () => {
  it("emits the workspace and its shell tools only for a valid checkout on an enabled desk, and refuses the rest by name", async () => {
    expect(
      await forAll(arbitrary, async (one) => {
        const { out, plans, seeded } = await attempt(one);
        if (one.checkout === "none") {return !out.isError && plans.length === 1 && plans.every((plan) => plan.defaults.agent.workspace === undefined && shellIn(plan.envelope.tools).length === 0 && thinkSteps(plan).every((step) => shellIn(step.agent?.tools).length === 0));}
        if (!one.enabled) {return out.isError && plans.length === 0 && out.text.includes("PEONS_CHECKOUT=on");}
        if (one.checkout === "bad-sha") {return out.isError && plans.length === 0 && out.text.includes("checkout.sha");}
        if (one.checkout === "bad-repo") {return out.isError && plans.length === 0 && out.text.includes("checkout.repo");}
        return (
          !out.isError &&
          plans.length === 1 &&
          plans.every(
            (plan) =>
              plan.defaults.agent.workspace?.sha === SHA &&
              shellIn(plan.defaults.agent.tools).length === WORKSPACE_TOOLS.length &&
              checkSubmission(plan, seeded[0] ?? []).length === 0 &&
              thinkSteps(plan).every((step) => step.prompt.includes("/work")),
          )
        );
      }, 60),
    ).toBeUndefined();
  });

  it("refuses shell tools without a workspace, and a workspace with a partial tool set", () => {
    const plan: MischiefSubmission = {
      defaults: { agent: { model: "sol" } },
      envelope: { maxAgents: 1, maxDepth: 1, maxSteps: 4, maxThinking: "low", models: ["sol"], names: [], thresholds: { judge: 0.8 }, tools: [...WORKSPACE_TOOLS] },
      id: "p",
      machine: { id: "p", initial: "work", states: { done: { type: "final" }, work: { meta: { step: { agent: { tools: ["bash"] }, kind: "think", prompt: "go" } }, on: { done: { target: "done" } } } } },
    };
    expect(checkSubmission(plan, []).join(" ")).toContain("need agent.workspace");
    const partial = { ...plan, defaults: { agent: { model: "sol", workspace: checkouts.good } } };
    expect(checkSubmission(partial, []).join(" ")).toContain("grants exactly");
  });
});
