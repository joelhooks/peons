import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { describe, expect, it } from "vitest";

import type { RunHostPort } from "../extensions/pi/host.ts";
import type { ToolOutput } from "../extensions/pi/tools.ts";
import { onGateway } from "../extensions/pi/tools.ts";
import { RouteRefused, resolveRoute } from "../src/routing.ts";
import type { Resolved } from "../src/routing.ts";
import { catalog, fakeHost, forAll, memoryFiles, pick, routing, run, toolsWith } from "./support.ts";

const kinds = ["scan", "work", "docs", "ask-template", "scan-opus", "bad-both", "bad-template", "bad-pin"] as const;
type Kind = (typeof kinds)[number];
const valid = (kind: Kind) => !kind.startsWith("bad-");

const job = (kind: Kind, index: number) => {
  const brief = `Job ${index}.`;
  if (kind === "ask-template") {return { brief, docs: { evidence: `slice ${index}` }, peon: "fix-ask@2" };}
  if (kind === "scan-opus") {return { brief, model: "opus", workType: "scan" };}
  if (kind === "bad-both") {return { brief, peon: "fix-ask@2", workType: "scan" };}
  if (kind === "bad-template") {return { brief, peon: "no-such@1" };}
  if (kind === "bad-pin") {return { brief, docs: { evidence: "x" }, model: "opus", peon: "fix-ask@2" };}
  return { brief, workType: kind };
};

type Swarm = (host: RunHostPort, raw: unknown) => Effect.Effect<ToolOutput>;
const JobsOnly = Schema.Struct({ jobs: Schema.Array(Schema.Unknown) });

const eagerSwarm = (): Swarm => (host, raw) =>
  Effect.gen(function* eagerGen() {
    const { jobs } = Schema.decodeUnknownSync(JobsOnly)(raw);
    const tools = toolsWith(host);
    let isError = false;
    for (const one of jobs) {isError = (yield* tools.peon_run(one)).isError || isError;}
    return { data: {}, isError, text: "" };
  });

const routed = (workType: string): Resolved => {
  const resolved = resolveRoute(routing, workType);
  if (resolved instanceof RouteRefused) {throw resolved;}
  return resolved;
};

const modelOf = (resolved: ReturnType<typeof onGateway>) => (resolved !== null && !(resolved instanceof Error) && "profile" in resolved.route.specialist ? resolved.route.specialist.profile.model : null);

const realSwarm = (files: ReturnType<typeof memoryFiles>["files"]): Swarm => (host, raw) => toolsWith(host, files).peon_swarm(raw);

// Two calls with the same jobs, as a desk retrying after a crash or a timeout.
const holds = async (swarm: (files: ReturnType<typeof memoryFiles>["files"]) => Swarm, picked: readonly Kind[]) =>
  await run(
    Effect.gen(function* holdsGen() {
      const fake = fakeHost();
      const { files } = memoryFiles();
      const jobs = picked.map((kind, index) => job(kind, index));
      const first = yield* swarm(files)(fake.host, { jobs });
      const afterFirst = fake.calls.submit.length;
      const second = yield* swarm(files)(fake.host, { jobs });
      if (!picked.every(valid)) {return first.isError && second.isError && fake.calls.submit.length === 0;}
      return !first.isError && !second.isError && afterFirst === picked.length && fake.calls.submit.length === afterFirst && new Set(fake.calls.submit).size === picked.length;
    }),
  );

const Picked = Arbitrary.array(pick(...kinds), { maxLength: 6, minLength: 1 });

describe("peon_swarm", () => {
  it("starts every job exactly once or, when any job is refused, starts none, across a repeated call", async () => {
    expect(await forAll(Picked, async (picked) => await holds(realSwarm, picked), 150)).toBeUndefined();
  });

  it("catches a planted swarm that submits jobs one by one before checking the rest", async () => {
    expect(await forAll(Picked, async (picked) => await holds(eagerSwarm, picked), 150)).toBeDefined();
  });

  it("reports one line per job from peon_status({ swarmId })", async () => {
    const fake = fakeHost();
    const { files } = memoryFiles();
    const tools = toolsWith(fake.host, files);
    const started = await run(tools.peon_swarm({ jobs: [job("scan", 0), job("work", 1), job("ask-template", 2)], swarmId: "drovr-a" }));
    expect(started.isError).toBe(false);
    const status = await run(tools.peon_status({ swarmId: "drovr-a" }));
    expect(status.isError).toBe(false);
    expect(status.text.split("\n")).toHaveLength(4);
    const reused = await run(tools.peon_swarm({ jobs: [job("docs", 0)], swarmId: "drovr-a" }));
    expect(reused.text.split("\n")[0]).toMatch(/^SwarmRefused:/u);
  });
});

describe("onGateway", () => {
  it("maps a routed provider model to its gateway alias, and a job's model wins", () => {
    expect(modelOf(onGateway(routed("work"), null))).toBe("sol");
    expect(modelOf(onGateway(routed("scan"), null))).toBe("luna");
    expect(modelOf(onGateway(routed("scan"), null, "opus"))).toBe("opus");
  });

  it("refuses a route the gateway cannot serve, and a model override on a template that pins its own", () => {
    const haiku = { ...routed("work"), route: { ...routed("work").route, specialist: { profile: { model: "claude-bridge/claude-haiku-5-5", thinking: "low" as const } } } };
    const refused = onGateway(haiku, null);
    expect(refused instanceof Error && refused.message.split("\n")[0]).toMatch(/^ModelRefused:/u);
    const loaded = catalog.think.find((template) => template.spec.template === "fix-ask") ?? null;
    const pinned = onGateway(null, loaded, "opus");
    expect(pinned instanceof Error && pinned.message.split("\n")[0]).toMatch(/^ModelRefused:/u);
  });
});
