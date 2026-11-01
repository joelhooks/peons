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

// What a dead search must look for: the symbol, or a whole file's name without its extension.
const searchTerm = ({ path, symbol }: { readonly path: string; readonly symbol: string }) =>
  symbol.length > 0 ? symbol : (path.split("/").at(-1) ?? "").replace(/\.[^.]+$/u, "");

const inWork = (path: string) => path.replace(/^\/work\//u, "");
const fileOf = (at: string) => inWork(at.slice(0, at.lastIndexOf(":")));

// A dead search is one plain grep or rg over all of /work, so the command cannot hide a hit: no lists,
// redirects or substitutions; no inverted, quiet or capped matches; no include, exclude, glob or type
// filters. grep must recurse; rg must be -uu, since /work has no .git and rg would skip hidden dirs like
// .github and obey any ignore files the repo ships. One `| grep -v` may follow, and only to drop the
// definition: the pattern is exactly the item's path, with optional ^ and /work/, and for a symbol it must
// end in the :<line>: of a proof in that file, since dropping the whole file would hide own-file use.
// Without the tail, the verifier drops the definition line itself.
const SHELL = /[;&<>`\n]|\$\(/u;
const LONG_BANNED = ["--invert-match", "--quiet", "--silent", "--files-without-match", "--max-count", "--exclude", "--include", "--glob", "--iglob", "--type", "--ignore-file"];
const SHORT_BANNED = /[vqLmgtT]/u;

const unquote = (token: string) => token.replace(/^(?<quote>['"])(?<inner>.*)\k<quote>$/u, "$<inner>");
const tokensOf = (part: string) => part.trim().split(/\s+/u).map(unquote);

const plainSearch = (head: string): boolean => {
  const [tool, ...args] = tokensOf(head);
  const long = args.filter((arg) => arg.startsWith("--")).map((arg) => arg.split("=")[0] ?? arg);
  const short = args.filter((arg) => /^-[^-]/u.test(arg)).join("");
  if (long.some((flag) => LONG_BANNED.some((banned) => flag.startsWith(banned))) || SHORT_BANNED.test(short)) {return false;}
  if (!args.some((arg) => arg === "/work" || arg === "/work/")) {return false;}
  if (tool === "grep") {return /[rR]/u.test(short) || long.includes("--recursive") || long.includes("--dereference-recursive");}
  if (tool === "rg") {return (short.match(/u/gu) ?? []).length >= 2 || (long.includes("--no-ignore") && long.includes("--hidden"));}
  return false;
};

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const definitionTail = (tail: string, parts: { readonly path: string; readonly symbol: string }, proof: readonly { readonly at: string }[]): boolean => {
  const tokens = tokensOf(tail);
  if (tokens.length !== 3 || tokens[0] !== "grep" || tokens[1] !== "-v" || parts.path.length === 0) {return false;}
  const shape = new RegExp(`^\\^?(?:/work/)?${escapeRegExp(inWork(parts.path))}(?::(?<line>[1-9][0-9]*):)?$`, "u").exec(tokens[2] ?? "");
  if (shape === null) {return false;}
  const line = shape.groups?.line;
  if (line === undefined) {return parts.symbol.length === 0;}
  return proof.some(({ at }) => fileOf(at) === inWork(parts.path) && at.endsWith(`:${line}`));
};

const searchShape = (command: string, parts: { readonly path: string; readonly symbol: string }, proof: readonly { readonly at: string }[]): boolean => {
  if (SHELL.test(command)) {return false;}
  // `a || b` splits into three parts, so it is refused with every other second pipe.
  const [head, tail, ...more] = command.split("|");
  if (head === undefined || more.length > 0 || !plainSearch(head)) {return false;}
  return tail === undefined || definitionTail(tail, parts, proof);
};

// Output lines left once the definition and .brain docs are dropped. A symbol's definition is a proof
// path:line in its own file, printed as path:line:text (grep -n, rg -n); a whole file drops its own lines.
const callers = (output: string, parts: { readonly path: string; readonly symbol: string }, proof: readonly { readonly at: string }[]) => {
  const definitions = proof.filter(({ at }) => parts.path.length > 0 && fileOf(at) === inWork(parts.path)).map(({ at }) => `${inWork(at)}:`);
  return output.split("\n").map((line) => inWork(line.trim())).filter((line) => {
    if (line.length === 0) {return false;}
    const file = line.slice(0, Math.max(0, line.indexOf(":")));
    if (file.startsWith(".brain/") || file.includes("/.brain/")) {return false;}
    if (parts.symbol.length === 0 && parts.path.length > 0 && file === inWork(parts.path)) {return false;}
    return !definitions.some((definition) => line.startsWith(definition));
  });
};

// v2 proof, read from /work. dead and drop-export quote a path:line tied to the item, as in v1. dead also
// needs a plain search over /work for the item that printed nothing but its definition and .brain docs.
// The output is self-reported: whoever acts on a dead verdict re-runs the exact command at the same sha.
export const verifyDeadCodeProofV2 = (verdict: typeof DeadCodeVerdictV2.Type): boolean => verdict.items.every((item) => {
  if (item.verdict !== "dead" && item.verdict !== "drop-export") {return true;}
  const parts = idParts(item.id);
  const located = item.proof.some(({ at, quote }) => (parts.path.length > 0 && (fileOf(at) === inWork(parts.path) || fileOf(at).endsWith(`/${parts.path}`))) || (parts.symbol.length > 0 && quote.includes(parts.symbol)));
  if (!located || item.verdict === "drop-export") {return located;}
  const term = searchTerm(parts);
  return term.length > 0 && item.searches.some(({ command, output }) => searchShape(command, parts, item.proof) && (command.split("|")[0] ?? "").includes(term) && callers(output, parts, item.proof).length === 0);
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
