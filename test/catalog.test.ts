import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { templateDigest } from "../extensions/pi/catalog.ts";
import { Catalog, cellReady } from "../src/contract.ts";
import { TemplateNode } from "../src/template-node.ts";

const catalog = Schema.decodeUnknownSync(Catalog)(JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf-8")));

describe("peons catalog", () => {
  it("decodes as peons.catalog.v1", () => {
    expect(catalog.entries.length).toBeGreaterThan(0);
  });

  it("names each template once", () => {
    const names = catalog.entries.map((entry) => entry.template);
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks an entry cell-ready exactly when its needs allow a cell", () => {
    for (const entry of catalog.entries) {
      expect(entry.cellReady, entry.template).toBe(cellReady(entry.needs));
    }
  });
});

const digestOf = (dir: string, ...args: string[]) => execFileSync("node", ["bin/digest.ts", dir, ...args], { encoding: "utf-8" }).trim();
const temp = () => mkdtempSync(nodePath.join(tmpdir(), "digest-"));

describe("bin/digest.ts", () => {
  it("digests a pending warmup as no refs, the same as templateDigest", () => {
    const raw = readFileSync("templates/arrows-svg/v1/template.json", "utf-8");
    const pending = { ...Schema.decodeSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(raw), warmup: { note: "later", owner: "x", status: "pending" } };
    const dir = temp();
    writeFileSync(nodePath.join(dir, "template.json"), JSON.stringify(pending));
    const node = Schema.decodeUnknownSync(TemplateNode)(pending);
    expect(digestOf(dir)).toBe(templateDigest(node));
  });

  it("reads supportedOperations only from Arrow 2+ models", () => {
    const dir = temp();
    const models = nodePath.join(dir, "models.json");
    writeFileSync(models, JSON.stringify({ models: [{ id: "arrow-1" }, { id: "other" }, { id: "arrow-2", supportedOperations: ["b", "a"] }] }));
    expect(digestOf("templates/arrows-svg/v1", "--models", models)).toMatch(/^[0-9a-f]{64}$/u);
  });
});
