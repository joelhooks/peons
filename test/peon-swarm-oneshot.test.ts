// The one-call swarm (Joel: "its too hard to spawn swarms of peons") and the fleet defaults that let a
// desk run peons with no env beyond its Rat King name.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { loadCatalog } from "../extensions/pi/catalog.ts";
import { identitySecretOf, liveEnv } from "../extensions/pi/live-host.ts";
import { SWARM_DEFAULT_WORK_TYPE, expandSwarm, onGateway } from "../extensions/pi/tools.ts";
import { Prompt } from "../src/compile.ts";
import { RouteRefused, resolveRoute } from "../src/routing.ts";
import { ROOT, fakeHost, memoryFiles, run, toolsWith } from "./support.ts";

describe("expandSwarm", () => {
  it("turns briefs into research jobs when nothing names a target", () => {
    expect(expandSwarm({ briefs: ["a", "b"] })).toEqual([
      { brief: "a", workType: SWARM_DEFAULT_WORK_TYPE },
      { brief: "b", workType: SWARM_DEFAULT_WORK_TYPE },
    ]);
  });

  it("fills shared fields into each job, and a job's own target replaces the shared one whole", () => {
    const out = expandSwarm({ briefs: ["c"], jobs: [{ brief: "a", peon: "fix-ask@2" }, { brief: "b", scope: ["x"] }], scope: ["src"], workType: "scan" });
    expect(out).toEqual([
      { brief: "a", peon: "fix-ask@2", scope: ["src"] },
      { brief: "b", scope: ["x"], workType: "scan" },
      { brief: "c", scope: ["src"], workType: "scan" },
    ]);
  });
});

describe("peon_swarm one call", () => {
  it("starts the same swarm from { workType, briefs } as from the long jobs form", async () => {
    const short = fakeHost();
    const long = fakeHost();
    const a = await run(toolsWith(short.host, memoryFiles().files).peon_swarm({ briefs: ["Job 0.", "Job 1."], workType: "scan" }));
    const b = await run(toolsWith(long.host, memoryFiles().files).peon_swarm({ jobs: [{ brief: "Job 0.", workType: "scan" }, { brief: "Job 1.", workType: "scan" }] }));
    expect(a.isError).toBe(false);
    expect(a.text.split("\n")[0]).toBe(b.text.split("\n")[0]);
    expect(short.calls.submit).toEqual(long.calls.submit);
    expect(short.calls.submit).toHaveLength(2);
  });

  it("refuses a call with no briefs and no jobs, and one over the cap, starting nothing", async () => {
    const fake = fakeHost();
    const tools = toolsWith(fake.host);
    const outs = await Promise.all([{}, { briefs: Array.from({ length: 65 }, (_, index) => `b${index}`), workType: "scan" }].map(async (raw) => await run(tools.peon_swarm(raw))));
    for (const out of outs) {expect(out.text.split("\n")[0]).toMatch(/^SwarmRefused:/u);}
    expect(fake.calls.submit).toHaveLength(0);
  });

  it("seam: the live default work type routes to a model the gateway serves", async () => {
    const live = await Effect.runPromise(loadCatalog(ROOT));
    const resolved = resolveRoute(live.routing, SWARM_DEFAULT_WORK_TYPE);
    expect(resolved).not.toBeInstanceOf(RouteRefused);
    if (resolved instanceof RouteRefused) {return;}
    const onIt = onGateway(resolved, null);
    expect(onIt).not.toBeInstanceOf(Error);
  });
});

describe("fleet defaults", () => {
  it("names the identity by Lockjaw's fleet convention from the Rat King name", () => {
    expect(identitySecretOf("aihero-perf/desk")).toBe("rat_king_fleet_agent_aihero-perf.desk_identity");
    expect(identitySecretOf("off")).toBeUndefined();
    expect(identitySecretOf("")).toBeUndefined();
  });

  it("takes the host from config and the identity from RATKING_NAME, and an explicit env wins", () => {
    const config = { mischiefHost: "http://m.example/" };
    expect(liveEnv({ RATKING_NAME: "peons/desk" }, "peon_run", config)).toMatchObject({ endpoint: "http://m.example/", secretName: "rat_king_fleet_agent_peons.desk_identity" });
    expect(liveEnv({ MISCHIEF_HOST: "http://o.example/", PEONS_DESK: "a/b", PEONS_IDENTITY_SECRET: "n", RATKING_NAME: "peons/desk" }, "peon_run", config)).toMatchObject({ endpoint: "http://o.example/", secretName: "n" });
    expect(liveEnv({ PEONS_DESK: "a/b", RATKING_NAME: "peons/desk" }, "peon_run", config)).toMatchObject({ secretName: "rat_king_fleet_agent_a.b_identity" });
    expect(liveEnv({ RATKING_NAME: "peons/desk" }, "peon_run")).toBeInstanceOf(Prompt);
  });
});
