import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeTools } from "../extensions/pi/tools.ts";
import { FROZEN_DOC, canonical, sha256 } from "../src/compile.ts";
import { frozenOf } from "../src/run-report.ts";
import { DESK, catalog, fakeHost, memoryFiles, mischiefRunId, run, toolsWith } from "./support.ts";

const start = async (runId = "scan", cwd = "/work") => {
  const fake = fakeHost();
  const tools = makeTools({ catalog, cwd, desk: Effect.succeed(DESK), files: memoryFiles().files, host: Effect.succeed(fake.host) });
  await run(tools.peon_run({ brief: "private input marker", runId, workType: "scan" }));
  const id = mischiefRunId(DESK, runId);
  const docs = fake.runs.get(id)?.report.docs;
  return { docs, fake, id, tools };
};

const withTempDir = (test: (cwd: string) => Promise<void>) => async () => {
  const cwd = await mkdtemp(nodePath.join(tmpdir(), "peon-read-"));
  try {await test(cwd);} finally {await rm(cwd, { force: true, recursive: true });}
};

const review = (quote: string) => ({ blockers: [{ claim: "Needs a fence", evidence: [{ quote, source: "subject" }] }], checked: ["diff"], findings: [{ claim: "Good name", evidence: [] }], schema: "peons.verdict.change-review.v1", unverified: ["host", "reload"], verdict: "block" });

describe("peon_read", () => {
  it("reads the frozen output by default and a named doc on request; status only hints at it", async () => {
    const { docs, fake, id, tools } = await start();
    const text = "an artifact 🐀\n";
    fake.patch(id, { docs: { ...docs, artifact: text, extra: { a: 2, z: 1 } }, status: "done" });
    const out = await run(tools.peon_read({ runId: "scan" }));
    expect(out).toMatchObject({ data: { bytes: Buffer.byteLength(text), doc: "artifact", path: null, sha256: sha256(text) }, isError: false });
    expect(out.text.endsWith(`\n\n${text}`)).toBe(true);
    const named = await run(tools.peon_read({ doc: "extra", runId: "scan" }));
    expect(named.text.endsWith('\n\n{"a":2,"z":1}')).toBe(true);
    const status = await run(tools.peon_status({ runId: "scan" }));
    expect(status.text).toContain('Check it with peon_verify. Read it with peon_read({ runId: "scan" }).');
    expect(JSON.stringify(status)).not.toContain(text.trim());
  });

  it.each([true, false])("leads with the quote check (exact: %s), then shows claims and counts before the raw verdict", async (exact) => {
    const fake = fakeHost();
    const tools = toolsWith(fake.host);
    const runId = "review";
    await run(tools.peon_run({ brief: "Review this", docs: { subject: "the exact source quote" }, runId, workType: "review" }));
    const id = mischiefRunId(DESK, runId);
    const raw = canonical(review(exact ? "exact source quote" : "altered source quote"));
    fake.patch(id, { docs: { ...fake.runs.get(id)?.report.docs, review: raw }, status: "done" });
    const out = await run(tools.peon_read({ runId }));
    expect(out.isError).toBe(!exact);
    expect(out.data).toMatchObject({ check: { outcome: exact ? "pass" : "fail" }, sha256: sha256(raw) });
    expect(out.text.startsWith(`${exact ? "✅" : "❌"} verdict-quotes:review:`)).toBe(true);
    expect(out.text).toContain(`Verdict: block\nBlockers:\n1. Needs a fence\nFindings:\n- Good name\nChecked: 1 · Unverified: 2\n\n${raw}`);
  });

  it("exports the full text privately, returns a valid UTF-8 prefix, and never overwrites", withTempDir(async (cwd) => {
    const runId = "scan/a";
    const { docs, fake, id, tools } = await start(runId, cwd);
    const prefix = "a".repeat(60 * 1024 - 1);
    const text = `${prefix}🐀tail`;
    fake.patch(id, { docs: { ...docs, artifact: text }, status: "done" });
    const path = nodePath.join(cwd, ".peons", "out", "scan%2Fa", "artifact");
    const out = await run(tools.peon_read({ runId }));
    expect(out).toMatchObject({ data: { bytes: Buffer.byteLength(text), path, sha256: sha256(text) }, isError: false });
    expect(out.text).toContain(`Full doc: ${path}`);
    expect(out.text.slice(out.text.indexOf("\n\n") + 2)).toBe(prefix);
    expect(await readFile(path, "utf-8")).toBe(text);
    const file = await stat(path);
    expect(file.mode % 0o1000).toBe(0o600);
    fake.patch(id, { docs: { ...docs, artifact: `${text}-changed` } });
    expect(await run(tools.peon_read({ runId }))).toMatchObject({ data: { tag: "FileUnwritable" }, isError: true });
    expect(await readFile(path, "utf-8")).toBe(text);
  }));

  it("refuses to export through a repo symlink", withTempDir(async (cwd) => {
    await withTempDir(async (other) => {
      await symlink(other, nodePath.join(cwd, ".peons"), "dir");
      const { docs, fake, id, tools } = await start("scan", cwd);
      fake.patch(id, { docs: { ...docs, artifact: "x".repeat(60 * 1024 + 1) }, status: "done" });
      expect(await run(tools.peon_read({ runId: "scan" }))).toMatchObject({ data: { tag: "FileUnwritable" }, isError: true });
      await expect(stat(nodePath.join(other, "out"))).rejects.toMatchObject({ code: "ENOENT" });
    })();
  }));

  it("refuses another desk's run by desk-local ID or direct leaf ID", async () => {
    const { docs, fake, id, tools } = await start();
    const artifact = "private output marker";
    fake.patch(id, { docs: { ...docs, artifact }, status: "done" });
    const otherDesk = "other/desk";
    const other = makeTools({ catalog, cwd: "/work", desk: Effect.succeed(otherDesk), files: memoryFiles().files, host: Effect.succeed(fake.host) });
    const leaf = `peon-${"b".repeat(40)}-a1`;
    const stored = fake.runs.get(id);
    if (stored === undefined) {throw new Error("expected a stored run");}
    const frozen = frozenOf(stored.report);
    if (frozen === null) {throw new Error("expected a frozen run");}
    fake.runs.set(leaf, { ...stored, report: { ...stored.report, docs: { ...stored.report.docs, [FROZEN_DOC]: { ...frozen, runId: leaf } }, runId: leaf } });
    expect(await run(tools.peon_read({ runId: leaf }))).toMatchObject({ data: { doc: "artifact" }, isError: false });
    const results = await Promise.all([run(other.peon_read({ runId: "scan" })), run(other.peon_read({ runId: leaf }))]);
    for (const out of results) {
      expect(out).toMatchObject({ data: { tag: "UnknownRun" }, isError: true });
      expect(out.text).not.toContain(artifact);
    }
    expect(fake.calls.inspect.slice(-2)).toEqual([mischiefRunId(otherDesk, "scan"), leaf]);
  });

  it("refuses a running run even if a doc already exists", async () => {
    const { docs, fake, id, tools } = await start();
    fake.patch(id, { docs: { ...docs, artifact: "partial output marker" } });
    const out = await run(tools.peon_read({ runId: "scan" }));
    expect(out).toMatchObject({ data: { tag: "ReadRefused" }, isError: true });
    expect(out.text).toContain("the run is running");
    expect(out.text).not.toContain("partial output marker");
  });

  it("lists doc names, not contents, for an unknown doc", async () => {
    const { docs, fake, id, tools } = await start();
    fake.patch(id, { docs: { ...docs, artifact: "private output marker", extra: "private extra marker" }, status: "done" });
    const out = await run(tools.peon_read({ doc: "toString", runId: "scan" }));
    expect(out).toMatchObject({ data: { tag: "DocMissing" }, isError: true });
    expect(out.text.split("\n").map((line) => line.split(":")[0])).toEqual(["DocMissing", "Accepted", "Fix", "Debug"]);
    expect(out.text).toContain('Accepted: "artifact", "extra"');
    expect(out.text).not.toContain("private");
  });
});
