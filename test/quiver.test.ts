import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { assertArrow2Plus, generate, priceUsd, QuiverRefusal, sha256 } from "../src/quiver.ts";
import { decideSpend } from "../src/spend.ts";
import { TemplateNode, frozen } from "../src/template-node.ts";
import { themify } from "../src/themify.ts";
import { bodyText, jsonResponse } from "./support.ts";

const ok = async (body: unknown) => await jsonResponse(body);
// A fetchImpl that answers with body, telling onCall what it was sent.
const respond = (body: unknown, onCall: (init: RequestInit) => void = () => {}) => async (_url: string, init: RequestInit) => {
  onCall(init);
  return await ok(body);
};
const Sent = Schema.Struct({ references: Schema.optionalKey(Schema.Array(Schema.Struct({ base64: Schema.String }))) });
const svg = '<svg viewBox="0 0 10 10"><text fill="#111111">Q</text></svg>';
const svgReply = {
  data: [{ svg }],
  id: "gen_1",
  usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 10_000 },
};

describe("Arrow 2+ only", () => {
  it.each(["arrow-2", "arrow-2-telos", "arrow-3", "arrow-10"])("allows %s", (model) => {
    expect(() => {
      assertArrow2Plus(model);
    }).not.toThrow();
  });
  it.each(["arrow-1", "arrow-1.1", "arrow-1.1-max", "arrow-preview", "gpt-6"])("refuses %s", (model) => {
    expect(() => {
      assertArrow2Plus(model);
    }).toThrow(QuiverRefusal);
  });
  it("refuses an old model before any network call", async () => {
    let called = false;
    await expect(
      generate({ model: "arrow-1.1", prompt: "x", requestId: "r1" }, { apiKey: "k", fetchImpl: respond(svgReply, () => { called = true; }) }),
    ).rejects.toThrow(/model-not-allowed/u);
    expect(called).toBe(false);
  });
});

describe("references", () => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "peons-test-"));
  const png = nodePath.join(dir, "ref.png");
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const good = { path: png, sha256: sha256(readFileSync(png)) };

  it("sends a checked reference as base64", async () => {
    let sent: typeof Sent.Type = {};
    await generate(
      { model: "arrow-2", prompt: "x", references: [good], requestId: "r2" },
      { apiKey: "k", fetchImpl: respond(svgReply, (init) => { sent = Schema.decodeUnknownSync(Sent)(JSON.parse(bodyText(init))); }) },
    );
    expect(sent.references).toEqual([{ base64: readFileSync(png).toString("base64") }]);
  });

  it("refuses a reference whose hash does not match, before spending", async () => {
    let called = false;
    await expect(
      generate(
        { model: "arrow-2", prompt: "x", references: [{ path: png, sha256: "0".repeat(64) }], requestId: "r3" },
        { apiKey: "k", fetchImpl: respond(svgReply, () => { called = true; }) },
      ),
    ).rejects.toThrow(/reference-unreadable: request r3/u);
    expect(called).toBe(false);
  });

  it("refuses a missing reference", async () => {
    await expect(
      generate(
        { model: "arrow-2", prompt: "x", references: [{ path: nodePath.join(dir, "nope.png"), sha256: good.sha256 }], requestId: "r4" },
        { apiKey: "k", fetchImpl: respond(svgReply) },
      ),
    ).rejects.toThrow(/reference-unreadable/u);
  });
});

describe("results", () => {
  it("prices tokens with cached input at a tenth", () => {
    // 1000 uncached * $4 + 1000 cached * $0.40 + 10000 out * $20, per million
    expect(priceUsd("arrow-2", { cacheRead: 1000, input: 2000, output: 10_000 })).toBeCloseTo(0.2044, 6);
  });
  it("refuses a reply with no SVG", async () => {
    await expect(
      generate({ model: "arrow-2", prompt: "x", requestId: "r5" }, { apiKey: "k", fetchImpl: respond({ data: [{ svg: "nope" }], id: "g" }) }),
    ).rejects.toThrow(/not-svg/u);
  });
  it("themes dark ink to a variable and adds the colour-scheme style", () => {
    const out = themify(svg);
    expect(out).toContain('fill="var(--ink)"');
    expect(out).toContain("prefers-color-scheme:dark");
  });
});

const reserved = (n: number) => Array.from({ length: n }, (_, i) => ({ at: "t", event: "reserved" as const, model: "arrow-2", requestId: `r${i}` }));

describe("spend", () => {
  it("allows the next call under the cap and counts unsettled reservations", () => {
    expect(decideSpend(reserved(3), 10)).toEqual({ call: 4, cap: 10, kind: "allowed" });
  });
  it("is exhausted at the cap; refusals do not count", () => {
    const facts = [...reserved(10), { at: "t", event: "refused" as const, refusal: "not-svg" as const, requestId: "x" }];
    expect(decideSpend(facts, 10)).toEqual({ cap: 10, kind: "exhausted", used: 10 });
    expect(decideSpend([{ at: "t", event: "refused", refusal: "model-not-allowed", requestId: "x" }], 1).kind).toBe("allowed");
  });
});

describe("the arrows-svg@1 template", () => {
  it("decodes and is frozen: warmup, canary and budget all set", () => {
    const raw: unknown = JSON.parse(readFileSync(new URL("../templates/arrows-svg/v1/template.json", import.meta.url), "utf-8"));
    const node = Schema.decodeUnknownSync(TemplateNode)(raw, { onExcessProperty: "error" });
    expect(frozen(node)).toBe(true);
  });
});
