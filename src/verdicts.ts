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

export const verdicts = {
  "peons.verdict.change-review.v1": ChangeReviewVerdict,
  "peons.verdict.investigation.v1": InvestigationVerdict,
} as const;

export const VerdictName = Schema.Literals(["peons.verdict.change-review.v1", "peons.verdict.investigation.v1"]);

interface Quoted { readonly evidence: readonly typeof Evidence.Type[] }

export const quotesOf = (verdict: typeof ChangeReviewVerdict.Type | typeof InvestigationVerdict.Type): readonly typeof Evidence.Type[] => {
  const groups: readonly (readonly Quoted[])[] =
    verdict.schema === "peons.verdict.change-review.v1" ? [verdict.blockers, verdict.findings] : [verdict.findings, verdict.ruledOut];
  return groups.flatMap((group) => group.flatMap((item) => item.evidence));
};

export const verifyQuotes = (
  verdict: typeof ChangeReviewVerdict.Type | typeof InvestigationVerdict.Type,
  docs: Readonly<Record<string, string>>,
): readonly typeof Evidence.Type[] => quotesOf(verdict).filter(({ source, quote }) => !(docs[source] ?? "").includes(quote));
