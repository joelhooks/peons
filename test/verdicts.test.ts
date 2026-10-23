import { describe, expect, it } from "vitest";

import { verifyQuotes } from "../src/verdicts.ts";

const docs = { brief: "Is it safe?", evidence: "Tests 47 passed | 2 skipped (49)" };

describe("verdict quotes", () => {
  it("pass when every quote is an exact substring of the doc it names", () => {
    expect(
      verifyQuotes(
        { blockers: [], checked: [], findings: [{ claim: "two skipped", evidence: [{ quote: "2 skipped", source: "evidence" }] }], schema: "peons.verdict.change-review.v1", unverified: [], verdict: "needs-evidence" },
        docs,
      ),
    ).toEqual([]);
  });

  it("name every quote that is paraphrased, invented, or cites the wrong doc", () => {
    const bad = verifyQuotes(
      {
        answer: "a",
        confidence: "low",
        findings: [{ claim: "c", evidence: [{ quote: "3 skipped", source: "evidence" }, { quote: "2 skipped", source: "brief" }], measured: true }],
        ruledOut: [{ evidence: [{ quote: "anything", source: "context" }], hypothesis: "h" }],
        schema: "peons.verdict.investigation.v1",
        unmeasured: [],
      },
      docs,
    );
    expect(bad.map(({ quote }) => quote)).toEqual(["3 skipped", "2 skipped", "anything"]);
  });
});
