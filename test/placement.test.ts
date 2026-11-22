import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect, Result, Schema } from "effect";
import { describe, expect, it, onTestFinished } from "vitest";

import { loadCatalog } from "../extensions/pi/catalog.ts";
import { makeTools } from "../extensions/pi/tools.ts";
import { Catalog as CatalogFile, Requires } from "../src/contract.ts";
import { mischiefRuntimes, place } from "../src/placement.ts";
import { ThinkTemplate } from "../src/think-template.ts";
import { DESK, ROOT, fakeHost, memoryFiles } from "./support.ts";

const mac = { capabilities: ["macos", "xcode"], name: "fake-mac", slots: 1 };

describe("runtime placement", () => {
  it("defaults to no requirements and places existing jobs on Mischief", () => {
    expect(Effect.runSync(place({ runtimes: mischiefRuntimes }))).toEqual({ runtime: "mischief", status: "placed" });
  });

  it("fails with the required capabilities and next call if no runtime declares them all", () => {
    const result = Effect.runSync(Effect.result(place({ requires: ["macos", "xcode"], runtimes: [...mischiefRuntimes, { ...mac, capabilities: ["macos"] }] })));
    expect(Result.isFailure(result) && result.failure).toMatchObject({ _tag: "NoRuntimeFor", requires: ["macos", "xcode"] });
    expect(Result.isFailure(result) && result.failure.fix).toContain("call peon_catalog");
  });

  it("places on a free Mac and queues when the only matching runtime is full, even with free Linux capacity", () => {
    const requires = ["macos"];
    const full = { ...mac, slots: 0 };
    expect(Effect.runSync(place({ requires, runtimes: [...mischiefRuntimes, full, { ...mac, name: "free-mac" }] }))).toEqual({ runtime: "free-mac", status: "placed" });
    expect(Effect.runSync(place({ requires, runtimes: [...mischiefRuntimes, full] }))).toEqual({ reason: "NoCapacity", requires, status: "queued" });
  });
});

const fixture = async (source: "catalog" | "template") => {
  const root = mkdtempSync(nodePath.join(tmpdir(), "peons-placement-"));
  onTestFinished(() => { rmSync(root, { force: true, recursive: true }); });
  const templateDir = "templates/investigation/v1";
  for (const path of ["catalog.json", "routing.json", templateDir]) {
    cpSync(nodePath.join(ROOT, path), nodePath.join(root, path), { recursive: true });
  }
  const requires = ["macos"];
  if (source === "catalog") {
    const path = nodePath.join(root, "catalog.json");
    const file = Schema.decodeUnknownSync(CatalogFile)(JSON.parse(readFileSync(path, "utf-8")));
    writeFileSync(path, JSON.stringify({ ...file, entries: file.entries.map((entry) => entry.template === "investigation" ? { ...entry, requires } : entry) }));
  } else {
    const path = nodePath.join(root, templateDir, "template.json");
    const spec = Schema.decodeUnknownSync(ThinkTemplate)(JSON.parse(readFileSync(path, "utf-8")));
    writeFileSync(path, JSON.stringify({ ...spec, requires }));
  }
  const catalog = await Effect.runPromise(loadCatalog(root));
  const fake = fakeHost();
  const { files, store } = memoryFiles();
  const tools = makeTools({ catalog, cwd: root, desk: Effect.succeed(DESK), files, host: Effect.succeed(fake.host) });
  return { calls: fake.calls, store, tools };
};

const brief = "Test placement";
const job = { brief, docs: { evidence: "test" }, peon: "investigation@1" };

describe("capability guard before Mischief", () => {
  it.each(["catalog", "template"] as const)("lists a %s requirement and refuses before talking to the host", async (source) => {
    const { calls, tools } = await fixture(source);
    const listing = await Effect.runPromise(tools.peon_catalog({}));
    const { entries } = Schema.decodeUnknownSync(Schema.Struct({ entries: Schema.Array(Schema.Struct({ requires: Requires, template: Schema.String })) }))(listing.data);
    expect(entries.find(({ template }) => template === "investigation")?.requires).toEqual(["macos"]);
    expect(listing.text).toMatch(/investigation@1[^\n]*requires macos/u);
    const result = await Effect.runPromise(tools.peon_run(job));
    expect(result).toMatchObject({ data: { result: { tag: "NoRuntimeFor", type: "peon.refused" } }, isError: true });
    expect(result.text).toContain('a runtime declaring ["macos"]');
    expect(result.text).toContain("Fix: call peon_catalog");
    expect(calls.inspect).toEqual([]);
    expect(calls.submit).toEqual([]);
  });

  it("refuses the whole swarm before submitting any jobs", async () => {
    const { calls, store, tools } = await fixture("catalog");
    const result = await Effect.runPromise(tools.peon_swarm({ jobs: [{ brief, workType: "scan" }, job] }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain("NoRuntimeFor");
    expect(calls.submit).toEqual([]);
    expect(store.size).toBe(0);
  });

  it.each([1, 2])("refuses to freeze a v%i workflow that cannot run", async (version) => {
    const { calls, store, tools } = await fixture("template");
    const evidence = version === 1 ? "input" : { from: "input.evidence" };
    const workflow = { desk: DESK, id: "mac-placement", schema: `peons.workflow.v${version}`, steps: [{ id: "test", input: { docs: { evidence }, text: brief }, kind: "peon", template: job.peon }], version: 1 };
    const result = await Effect.runPromise(tools.workflow_define({ workflow }));
    expect(result).toMatchObject({ data: { tag: "NoRuntimeFor" }, isError: true });
    expect(calls.submit).toEqual([]);
    expect(store.size).toBe(0);
  });
});
