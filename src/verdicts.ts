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

const DeadCodeId = NonEmpty.check(Schema.isPattern(/^(?:[^#]+(?:#[^#]*)?|#[^#]+)$/u));

export const DeadCodeVerdict = Schema.Struct({
  items: Schema.Array(Schema.Struct({
    confidence: Schema.Literals(["high", "medium", "low"]),
    id: DeadCodeId,
    proof: Schema.NonEmptyArray(Evidence),
    testFilesCoveringOnlyIt: Schema.Array(NonEmpty),
    verdict: Schema.Literals(["dead", "live", "drop-export", "unsure"]),
  })),
  schema: Schema.Literal("peons.verdict.dead-code.v1"),
});

// v2 reads the checkout at /work, so there is no evidence doc to quote: proof is a path:line in /work,
// and every search is the exact command run there with its exact output.
export const DeadCodeVerdictV2 = Schema.Struct({
  items: Schema.Array(Schema.Struct({
    confidence: Schema.Literals(["high", "medium", "low"]),
    id: DeadCodeId,
    proof: Schema.NonEmptyArray(Schema.Struct({ at: NonEmpty.check(Schema.isPattern(/^[^:\s]+:[1-9][0-9]*$/u)), quote: NonEmpty })),
    searches: Schema.Array(Schema.Struct({ command: NonEmpty, output: Schema.String })),
    testFilesCoveringOnlyIt: Schema.Array(NonEmpty),
    verdict: Schema.Literals(["dead", "live", "drop-export", "unsure"]),
  })),
  schema: Schema.Literal("peons.verdict.dead-code.v2"),
});

export type Verdict = typeof ChangeReviewVerdict.Type | typeof InvestigationVerdict.Type | typeof DeadCodeVerdict.Type | typeof DeadCodeVerdictV2.Type;

// Compare against the run's own batch, not ids supplied by the model. Empty batches are valid.
export const verifyDeadCodeBatch = (verdict: { readonly items: readonly { readonly id: string }[] }, batch: string | undefined): boolean => {
  if (batch === undefined) {return false;}
  let value: unknown;
  try {value = JSON.parse(batch);} catch {return false;}
  const decoded = Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ id: NonEmpty })))(value);
  if (decoded._tag === "None") {return false;}
  const expected = decoded.value.map(({ id }) => id);
  const actual = verdict.items.map(({ id }) => id);
  return new Set(expected).size === expected.length && new Set(actual).size === actual.length && expected.length === actual.length && actual.every((id) => expected.includes(id));
};

// A destructive recommendation needs at least one quote tied to this item. Other exact quotes
// may add context; dynamic-load evidence may name only the path, not the symbol.
export const verifyDeadCodeProof = (verdict: typeof DeadCodeVerdict.Type): boolean => verdict.items.every((item) => {
  if (item.verdict !== "dead" && item.verdict !== "drop-export") {return true;}
  const separator = item.id.indexOf("#");
  const path = separator === -1 ? item.id : item.id.slice(0, separator);
  const symbol = separator === -1 ? "" : item.id.slice(separator + 1);
  return item.proof.some(({ quote }) => (path.length > 0 && quote.includes(path)) || (symbol.length > 0 && quote.includes(symbol)));
});

const idParts = (id: string) => {
  const separator = id.indexOf("#");
  return separator === -1 ? { path: id, symbol: "" } : { path: id.slice(0, separator), symbol: id.slice(separator + 1) };
};

// Test and fixture references count as use, so a search that leaves them out cannot prove dead.
// Word-bounded, so --exclude-dir=test counts and a symbol like testHelper does not.
const TEST_PATHS = /(?:^|[^\w-])(?:test|tests|__tests__|fixtures)(?:[^\w-]|$)|\.(?:test|spec)\./u;

// What a dead search must look for: the symbol, or a whole file's name without its extension.
const searchTerm = ({ path, symbol }: { readonly path: string; readonly symbol: string }) =>
  symbol.length > 0 ? symbol : (path.split("/").at(-1) ?? "").replace(/\.[^.]+$/u, "");

const fileOf = (at: string) => at.slice(0, at.lastIndexOf(":"));

// v2 proof, read from /work. dead and drop-export quote a path:line tied to the item, as in v1. dead also
// needs an exact command over /work that looks for the item, does not leave out tests or fixtures, and
// printed nothing once the definition line was excluded. An empty search is the claim; the quote is where.
export const verifyDeadCodeProofV2 = (verdict: typeof DeadCodeVerdictV2.Type): boolean => verdict.items.every((item) => {
  if (item.verdict !== "dead" && item.verdict !== "drop-export") {return true;}
  const parts = idParts(item.id);
  const located = item.proof.some(({ at, quote }) => (parts.path.length > 0 && (fileOf(at) === parts.path || fileOf(at).endsWith(`/${parts.path}`))) || (parts.symbol.length > 0 && quote.includes(parts.symbol)));
  if (!located || item.verdict === "drop-export") {return located;}
  const term = searchTerm(parts);
  return term.length > 0 && item.searches.some(({ command, output }) => {
    const rest = parts.path.length > 0 ? command.replaceAll(parts.path, "") : command;
    return command.includes("/work") && command.includes(term) && output.trim() === "" && !TEST_PATHS.test(rest);
  });
});

export const verdicts = {
  "peons.verdict.change-review.v1": ChangeReviewVerdict,
  "peons.verdict.dead-code.v1": DeadCodeVerdict,
  "peons.verdict.dead-code.v2": DeadCodeVerdictV2,
  "peons.verdict.investigation.v1": InvestigationVerdict,
} as const;

export const VerdictName = Schema.Literals(["peons.verdict.change-review.v1", "peons.verdict.investigation.v1", "peons.verdict.dead-code.v1", "peons.verdict.dead-code.v2"]);

interface Quoted { readonly evidence: readonly typeof Evidence.Type[] }

// v2 quotes come from /work, not from a run doc, so there is nothing here to check them against.
export const quotesOf = (verdict: Verdict): readonly typeof Evidence.Type[] => {
  if (verdict.schema === "peons.verdict.dead-code.v2") {return [];}
  if (verdict.schema === "peons.verdict.dead-code.v1") {return verdict.items.flatMap((item) => item.proof);}
  const groups: readonly (readonly Quoted[])[] =
    verdict.schema === "peons.verdict.change-review.v1" ? [verdict.blockers, verdict.findings] : [verdict.findings, verdict.ruledOut];
  return groups.flatMap((group) => group.flatMap((item) => item.evidence));
};

export const verifyQuotes = (
  verdict: Verdict,
  docs: Readonly<Record<string, string>>,
): readonly typeof Evidence.Type[] => quotesOf(verdict).filter(({ source, quote }) => !(docs[source] ?? "").includes(quote));
