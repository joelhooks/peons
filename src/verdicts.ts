// What a think peon writes into its output doc. fromRunReport decodes the doc with the schema its
// template names; a doc that is not JSON, or does not decode, is a failed run, never a done one.
import { Schema } from "effect";

const NonEmpty = Schema.String.check(Schema.isMinLength(1));

export const Evidence = Schema.Struct({
  quote: NonEmpty,
  source: NonEmpty,
});

export const ChangeReviewVerdict = Schema.Struct({
  blockers: Schema.Array(Schema.Struct({ claim: NonEmpty, evidence: Schema.NonEmptyArray(Evidence) })),
  checked: Schema.Array(NonEmpty),
  findings: Schema.Array(Schema.Struct({ claim: NonEmpty, evidence: Schema.Array(Evidence) })),
  schema: Schema.Literal("peons.verdict.change-review.v1"),
  unverified: Schema.Array(NonEmpty),
  verdict: Schema.Literals(["approve", "block", "needs-evidence"]),
});

export const InvestigationVerdict = Schema.Struct({
  answer: NonEmpty,
  confidence: Schema.Literals(["high", "medium", "low"]),
  findings: Schema.Array(Schema.Struct({ claim: NonEmpty, evidence: Schema.NonEmptyArray(Evidence), measured: Schema.Boolean })),
  ruledOut: Schema.Array(Schema.Struct({ evidence: Schema.NonEmptyArray(Evidence), hypothesis: NonEmpty })),
  schema: Schema.Literal("peons.verdict.investigation.v1"),
  unmeasured: Schema.Array(NonEmpty),
});

export const DeadCodeVerdict = Schema.Struct({
  items: Schema.Array(Schema.Struct({
    confidence: Schema.Literals(["high", "medium", "low"]),
    id: NonEmpty.check(Schema.isPattern(/^[^#]+#[^#]+$/u)),
    proof: Schema.NonEmptyArray(Evidence),
    testFilesCoveringOnlyIt: Schema.Array(NonEmpty),
    verdict: Schema.Literals(["dead", "live", "drop-export", "unsure"]),
  })),
  schema: Schema.Literal("peons.verdict.dead-code.v1"),
});

export type Verdict = typeof ChangeReviewVerdict.Type | typeof InvestigationVerdict.Type | typeof DeadCodeVerdict.Type;

// Compare against the run's own batch, not ids supplied by the model. Empty batches are valid.
export const verifyDeadCodeBatch = (verdict: typeof DeadCodeVerdict.Type, batch: string | undefined): boolean => {
  if (batch === undefined) {return false;}
  let value: unknown;
  try {value = JSON.parse(batch);} catch {return false;}
  const decoded = Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ id: NonEmpty })))(value);
  if (decoded._tag === "None") {return false;}
  const expected = decoded.value.map(({ id }) => id);
  const actual = verdict.items.map(({ id }) => id);
  return new Set(expected).size === expected.length && new Set(actual).size === actual.length && expected.length === actual.length && actual.every((id) => expected.includes(id));
};

export const verdicts = {
  "peons.verdict.change-review.v1": ChangeReviewVerdict,
  "peons.verdict.dead-code.v1": DeadCodeVerdict,
  "peons.verdict.investigation.v1": InvestigationVerdict,
} as const;

export const VerdictName = Schema.Literals(["peons.verdict.change-review.v1", "peons.verdict.investigation.v1", "peons.verdict.dead-code.v1"]);

interface Quoted { readonly evidence: readonly typeof Evidence.Type[] }

export const quotesOf = (verdict: Verdict): readonly typeof Evidence.Type[] => {
  if (verdict.schema === "peons.verdict.dead-code.v1") {return verdict.items.flatMap((item) => item.proof);}
  const groups: readonly (readonly Quoted[])[] =
    verdict.schema === "peons.verdict.change-review.v1" ? [verdict.blockers, verdict.findings] : [verdict.findings, verdict.ruledOut];
  return groups.flatMap((group) => group.flatMap((item) => item.evidence));
};

export const verifyQuotes = (
  verdict: Verdict,
  docs: Readonly<Record<string, string>>,
): readonly typeof Evidence.Type[] => quotesOf(verdict).filter(({ source, quote }) => !(docs[source] ?? "").includes(quote));
