import * as Arbitrary from "effect/Arbitrary";
import { describe, expect, it } from "vitest";

import { listCost, usageOf } from "../src/list-cost.ts";
import { RunReport } from "../src/run-report.ts";
import { Tokens } from "../src/contract.ts";
import { Schema } from "effect";
import { forAll, int } from "./support.ts";

const Usage = Arbitrary.all({ cacheRead: int(0, 1_000_000), cacheWrite: int(1, 1_000_000), input: int(0, 1_000_000), output: int(0, 1_000_000) });

describe("list-price-equivalent cost", () => {
  it("equals the price-table sum over generated tokens, with explicit and legacy cache writes", async () => {
    expect(await forAll(Usage, (tokens) => {
      const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
      const line = `opus · ${total.toLocaleString("en-US")} tok · finished`;
      const { cacheWrite: _write, ...legacy } = tokens;
      for (const model of ["opus", "claude-opus-5-5", "sol", "gpt-6.1-sol", "openai-codex/gpt-6.1-sol"]) {
        const opus = model === "opus" || model === "claude-opus-5-5";
        const expected = (tokens.input * (opus ? 4 : 2) + tokens.output * (opus ? 20 : 10) + tokens.cacheRead * (opus ? 0.2 : 0.1) + tokens.cacheWrite * (opus ? 5 : 2.5)) / 1_000_000;
        for (const raw of [tokens, legacy]) {
          // Exercise the host decoder as well: dropping cacheWrite here must not erase paid usage.
          const report = Schema.decodeSync(RunReport)({ docs: {}, planId: "test", planVersion: 1, runId: "test", status: "done", thinking: { line, tokens: raw }, transitions: 1, value: "done" });
          const priced = listCost([model], report.thinking);
          if (priced.costUsd !== expected || priced.costReason !== null || priced.tokens?.cacheWrite !== tokens.cacheWrite) {return false;}
        }
      }
      return Schema.decodeSync(Tokens)(tokens).cacheWrite === tokens.cacheWrite;
    }, 200)).toBeUndefined();
  });

  it("keeps unknown/mixed models and absent or inconsistent legacy usage unknown, not free", () => {
    const thinking = { line: "fixture · 10 tok · done", tokens: { cacheRead: 1, input: 2, output: 3 } };
    expect(usageOf(thinking)?.cacheWrite).toBe(4);
    expect(usageOf({ ...thinking, line: "fixture · 1 tok · done" })).toBeNull();
    expect(usageOf({ ...thinking, line: "no total" })).toBeNull();
    expect(listCost(["luna"], thinking)).toMatchObject({ costReason: "unknown list price for model luna", costUsd: null });
    expect(listCost(["gpt-6-luna"], thinking).costUsd).toBeNull();
    expect(listCost(["sol", "opus"], thinking).costUsd).toBeNull();
    expect(listCost(["sol"]).costUsd).toBeNull();
    expect(listCost(["sol"], { line: "no total", tokens: { ...thinking.tokens, cacheWrite: 0 } }).costUsd).toBeGreaterThan(0);
  });
});
