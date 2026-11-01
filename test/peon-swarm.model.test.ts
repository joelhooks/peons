// Generated peon_swarm/peon_status sequences against a reference model of swarm history: which swarm
// ids are recorded with which jobs, and which runs the host has started. The real tools run over the
// in-memory host and files, so a swarm record written by one call is what the next call reads.
import { Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { describe, expect, it } from "vitest";

import { canonical } from "../src/compile.ts";
import { firstOf, replay, same } from "./command-model.ts";
import { DESK, fakeHost, forAll, memoryFiles, mischiefRunId, run, toolsWith } from "./support.ts";

const kinds = ["scan", "work", "ask-template", "scan-opus", "bad-both", "bad-template", "bad-pin"] as const;
type Kind = (typeof kinds)[number];
const JobSpec = Schema.Struct({ kind: Schema.Literals(kinds), variant: Schema.Literals([0, 1]) });
type JobSpec = typeof JobSpec.Type;

const job = ({ kind, variant }: JobSpec, index: number) => {
  const brief = `Job ${index}, take ${variant}.`;
  if (kind === "ask-template") {return { brief, docs: { evidence: `slice ${index}` }, peon: "fix-ask@2" };}
  if (kind === "scan-opus") {return { brief, model: "opus", workType: "scan" };}
  if (kind === "bad-both") {return { brief, peon: "fix-ask@2", workType: "scan" };}
  if (kind === "bad-template") {return { brief, peon: "no-such@1" };}
  if (kind === "bad-pin") {return { brief, docs: { evidence: "x" }, model: "opus", peon: "fix-ask@2" };}
  return { brief, workType: kind };
};
const refused = (kind: Kind) => kind.startsWith("bad-");
// A job's identity (its digest and default run id) covers base, input, scope and target, but not a
// model override: today scan-opus is the same job as scan. See the pinned finding below.
const identity = (specs: readonly JobSpec[]) => canonical(specs.map(({ kind, variant }) => ({ kind: kind === "scan-opus" ? "scan" : kind, variant })));

// A small menu of job lists makes repeats (same id, same or different jobs) common.
const Command = Schema.Union([
  Schema.Struct({ menu: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 0 })), op: Schema.Literal("swarm"), slot: Schema.Literals(["a", "b", "auto"]) }),
  Schema.Struct({ op: Schema.Literal("status"), slot: Schema.Literals(["a", "b"]) }),
]);
type Command = typeof Command.Type;
// Weighted towards valid jobs so that whole swarms start, and then repeat, often enough.
const weighted: readonly Kind[] = ["scan", "scan", "work", "work", "ask-template", "scan-opus", "scan-opus", "bad-both", "bad-template", "bad-pin"];
const JobArb = Arbitrary.map(Arbitrary.all({ kind: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum: weighted.length - 1, minimum: 0 }))), variant: Arbitrary.schema(JobSpec.fields.variant) }), ({ kind, variant }): JobSpec => ({ kind: weighted[kind] ?? "scan", variant }));
const Case = Arbitrary.all({
  commands: Arbitrary.array(Arbitrary.schema(Command), { maxLength: 10, minLength: 1 }),
  menu: Arbitrary.array(Arbitrary.array(JobArb, { maxLength: 3, minLength: 1 }), { maxLength: 4, minLength: 4 }),
});

const SwarmData = Schema.Struct({ refused: Schema.optionalKey(Schema.Array(Schema.Int)), runIds: Schema.optionalKey(Schema.Array(Schema.String)), swarmId: Schema.optionalKey(Schema.String) });
const StatusData = Schema.Struct({ results: Schema.optionalKey(Schema.Array(Schema.Unknown)), tag: Schema.optionalKey(Schema.String) });

// What generated runs reached, so a narrowed generator cannot pass vacuously.
const seen = new Set<string>();

const holds = async ({ commands, menu }: { commands: readonly Command[]; menu: readonly (readonly JobSpec[])[] }, report?: (why: string) => void) => {
  const fake = fakeHost();
  const { files, store } = memoryFiles();
  const tools = toolsWith(fake.host, files);
  // Model: recorded swarms (id -> job list key and run ids), every run the host should hold, and
  // the id each auto swarm received, keyed by its jobs.
  const swarms = new Map<string, { key: string; runIds: readonly string[] }>();
  const started = new Set<string>();
  const autoIds = new Map<string, string>();

  const swarm = async (slot: "a" | "b" | "auto", specs: readonly JobSpec[]) => {
    const key = identity(specs);
    const jobs = specs.map(job);
    const out = await run(tools.peon_swarm(slot === "auto" ? { jobs } : { jobs, swarmId: `swarm-${slot}` }));
    const data = Schema.decodeUnknownSync(SwarmData)(out.data);
    // The auto id hashes the raw jobs, model override included.
    const id = slot === "auto" ? (autoIds.get(canonical(specs)) ?? data.swarmId ?? "") : `swarm-${slot}`;
    const bad = specs.flatMap(({ kind }, index) => (refused(kind) ? [index] : []));
    const prior = swarms.get(id);
    if (bad.length > 0) {
      seen.add("refused job");
      return firstOf(same("refused", out.isError, true), same("refused jobs", data.refused, bad), out.text.startsWith("SwarmRefused:") ? undefined : "refusal is not SwarmRefused");
    }
    if (prior !== undefined && prior.key !== key) {
      seen.add("refused reuse");
      return firstOf(same("reuse refused", out.isError, true), out.text.startsWith("SwarmRefused:") ? undefined : "reuse refusal is not SwarmRefused");
    }
    const runIds = specs.map((_, index) => `${id}-${index}`);
    if (slot === "auto") {
      if (!/^swarm-[0-9a-f]{16}$/u.test(id)) {return `auto swarm id ${id} is not derived from its jobs`;}
      autoIds.set(canonical(specs), id);
    }
    seen.add(prior === undefined ? `started ${slot === "auto" ? "auto" : "named"}` : `repeated ${slot === "auto" ? "auto" : "named"}`);
    swarms.set(id, { key, runIds });
    for (const runId of runIds) {started.add(runId);}
    return firstOf(same("started", out.isError, false), same("swarm id", data.swarmId, id), same("run ids", data.runIds, runIds));
  };

  const status = async (slot: "a" | "b") => {
    const id = `swarm-${slot}`;
    const out = await run(tools.peon_status({ swarmId: id }));
    const data = Schema.decodeUnknownSync(StatusData)(out.data);
    const recorded = swarms.get(id);
    seen.add(recorded === undefined ? "status unknown" : "status known");
    if (recorded === undefined) {return firstOf(same("unknown swarm", out.isError, true), same("tag", data.tag, "UnknownSwarm"));}
    return firstOf(
      same("status ok", out.isError, false),
      same("one result per job", data.results?.length, recorded.runIds.length),
      (data.results ?? []).includes(null) ? "a recorded job is missing on the host" : undefined,
      same("status lines", out.text.split("\n").length, recorded.runIds.length + 1),
    );
  };

  return await replay(commands, async (command) => {
    const why = command.op === "swarm" ? await swarm(command.slot, menu[command.menu] ?? []) : await status(command.slot);
    // After every step: the host holds exactly the model's runs, each charged once, and only
    // recorded swarms have a manifest on disk.
    const runs = [...started].map((runId) => mischiefRunId(DESK, runId)).toSorted();
    return firstOf(
      why,
      same("host runs", [...fake.runs.keys()].toSorted(), runs),
      same("charges", fake.calls.charges.toSorted(), runs),
      same("manifests", [...store.keys()].map((path) => path.split("/").at(-1) ?? "").toSorted(), [...swarms.keys()].map((id) => `${id}.json`).toSorted()),
    );
  }, report);
};

describe("peon_swarm command model", () => {
  it("generated swarm/status sequences match the all-or-none, submit-once swarm model after every step", async () => {
    let why = "";
    const failure = await forAll(Case, async (value) => await holds(value, (mismatch) => { why = mismatch; }), 200);
    expect(failure === undefined ? undefined : `${failure}\n${why}`).toBeUndefined();
    expect([...seen].toSorted()).toEqual(["refused job", "refused reuse", "repeated auto", "repeated named", "started auto", "started named", "status known", "status unknown"]);
  }, 30_000);

  // Finding, not fixed here: a rerun under the same swarmId that only adds model: "opus" passes the
  // same-jobs check, submits nothing, and reports the earlier luna run as the opus job's answer.
  // This flips to passing once the model override is part of the job digest.
  it.fails("refuses a same-id rerun whose only change is a model override", async () => {
    const scan: JobSpec = { kind: "scan", variant: 0 };
    const tools = toolsWith(fakeHost().host, memoryFiles().files);
    await run(tools.peon_swarm({ jobs: [job(scan, 0)], swarmId: "swarm-a" }));
    const rerun = await run(tools.peon_swarm({ jobs: [job({ ...scan, kind: "scan-opus" }, 0)], swarmId: "swarm-a" }));
    expect(rerun.text.split("\n")[0]).toMatch(/^SwarmRefused:/u);
  });

  it("a hand-picked history: refused, started, retried, reused with other jobs, then inspected", async () => {
    const scan: JobSpec = { kind: "scan", variant: 0 };
    const menu = [[scan, { kind: "bad-template", variant: 0 }], [scan, { kind: "ask-template", variant: 1 }], [{ ...scan, variant: 1 }], [scan]] as const;
    const commands: Command[] = [
      { menu: 0, op: "swarm", slot: "a" },
      { op: "status", slot: "a" },
      { menu: 1, op: "swarm", slot: "a" },
      { menu: 1, op: "swarm", slot: "a" },
      { menu: 2, op: "swarm", slot: "a" },
      { menu: 3, op: "swarm", slot: "auto" },
      { menu: 3, op: "swarm", slot: "auto" },
      { op: "status", slot: "a" },
    ];
    let why = "";
    expect(await holds({ commands, menu }, (mismatch) => { why = mismatch; })).toBe(true);
    expect(why).toBe("");
  });
});
