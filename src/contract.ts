// The one peon contract. A desk tool, a workflow step and Mischief all decode these shapes; none
// keeps its own copy. A peon fork is a child conversation inside a Mischief run and has no Rat King
// name: results are addressed by (desk, runId) and land in that desk's queue. Every request and record
// carries a versioned schema literal; new fields arrive only as Schema.optionalKey.
import { Schema } from "effect";

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const GitSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{7,40}$/u));
const Slug = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,47}$/u));
const RunId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/u));
const DeskName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/u));
const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const Concept = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,47}$/u));
const PeonAt = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,47}@[1-9][0-9]*$/u));

export const PeonKind = Schema.Literals(["read", "judge", "classify", "measure", "work"]);

export const Need = Schema.Literals(["model-only", "read-only", "shell", "git-commit", "network", "secrets", "browser"]);

export const TemplateRef = Schema.Struct({
  digest: Sha256,
  template: Slug,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export const Brief = Schema.Struct({
  docs: Schema.Record(Slug, Schema.String),
  kind: Schema.Literal("brief"),
  text: NonEmpty,
});

export const Event = Schema.Struct({
  data: Schema.Json,
  kind: Schema.Literal("event"),
  name: NonEmpty,
});

export const Base = Schema.Struct({
  repo: NonEmpty,
  sha: GitSha,
});

export const Target = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("template"), template: Slug, version: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))) }),
  Schema.Struct({ kind: Schema.Literal("work-type"), workType: Concept }),
]);

export const Profile = Schema.Struct({
  model: NonEmpty,
  thinking: Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
});

export const Route = Schema.Struct({
  concept: Concept,
  specialist: Schema.Union([Schema.Struct({ peon: PeonAt }), Schema.Struct({ profile: Profile })]),
  status: Schema.Literals(["provisional", "measured"]),
  tableVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const PeonRequest = Schema.Struct({
  base: Schema.NullOr(Base),
  desk: DeskName,
  input: Schema.Union([Brief, Event]),
  runId: RunId,
  schema: Schema.Literal("peons.request.v1"),
  scope: Schema.Array(NonEmpty),
  target: Target,
});

export const PeonHandle = Schema.Struct({
  runId: RunId,
  status: Schema.Literal("running"),
  template: Schema.NullOr(TemplateRef),
});

export const Check = Schema.Struct({
  detail: Schema.NullOr(Schema.String),
  name: NonEmpty,
  outcome: Schema.Literals(["pass", "fail", "skip"]),
});

export const Artifact = Schema.Union([
  Schema.Struct({ bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), kind: Schema.Literal("doc"), name: Slug, sha256: Sha256 }),
  Schema.Struct({ bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), kind: Schema.Literal("file"), path: NonEmpty, sha256: Sha256 }),
  Schema.Struct({ base: GitSha, branch: NonEmpty, kind: Schema.Literal("commit"), repo: NonEmpty, sha: GitSha }),
]);

export const Tokens = Schema.Struct({
  cacheRead: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cacheWrite: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  input: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  output: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const FourLine = Schema.Struct({
  accepted: NonEmpty,
  debug: NonEmpty,
  fix: NonEmpty,
  tag: Schema.String.check(Schema.isPattern(/^(?:[A-Z][A-Za-z0-9]{0,63}|[a-z][a-z0-9-]{0,63})$/u)),
});

export const PeonDone = Schema.Struct({
  artifact: Artifact,
  checks: Schema.Array(Check),
  desk: DeskName,
  profile: Profile,
  route: Schema.NullOr(Route),
  runId: RunId,
  schema: Schema.Literal("peons.record.v1"),
  template: Schema.NullOr(TemplateRef),
  tokens: Tokens,
  type: Schema.Literal("peon.done"),
});

export const PeonBlocked = Schema.Struct({
  choices: Schema.Array(NonEmpty),
  desk: DeskName,
  messageId: NonEmpty,
  question: NonEmpty,
  recommendation: Schema.NullOr(Schema.String),
  route: Schema.NullOr(Route),
  runId: RunId,
  schema: Schema.Literal("peons.record.v1"),
  step: NonEmpty,
  template: Schema.NullOr(TemplateRef),
  type: Schema.Literal("peon.blocked"),
});

export const PeonFailed = Schema.Struct({
  desk: DeskName,
  profile: Profile,
  route: Schema.NullOr(Route),
  runId: RunId,
  schema: Schema.Literal("peons.record.v1"),
  step: NonEmpty,
  template: Schema.NullOr(TemplateRef),
  type: Schema.Literal("peon.failed"),
  ...FourLine.fields,
  tokens: Tokens,
});

export const PeonRefused = Schema.Struct({
  desk: DeskName,
  route: Schema.NullOr(Route),
  runId: RunId,
  schema: Schema.Literal("peons.record.v1"),
  template: Slug,
  type: Schema.Literal("peon.refused"),
  ...FourLine.fields,
});

export const PeonRecord = Schema.Union([PeonDone, PeonBlocked, PeonFailed, PeonRefused]);

export const PeonRunResult = Schema.Union([PeonHandle, PeonRecord]);

export const CatalogEntry = Schema.Struct({
  cellReady: Schema.Boolean,
  evidence: Schema.Struct({ count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), repoCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), source: NonEmpty }),
  input: NonEmpty,
  kind: PeonKind,
  model: NonEmpty,
  needs: Schema.NonEmptyArray(Need),
  output: NonEmpty,
  owner: DeskName,
  refusals: Schema.Array(NonEmpty),
  summary: NonEmpty,
  template: Slug,
  thinking: Schema.Literals(["low", "medium", "high", "xhigh", "max"]),
  verify: NonEmpty,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export const Catalog = Schema.Struct({
  entries: Schema.Array(CatalogEntry),
  schema: Schema.Literal("peons.catalog.v1"),
});

export type PeonRequest = typeof PeonRequest.Type;
export type PeonRecord = typeof PeonRecord.Type;
export type CatalogEntry = typeof CatalogEntry.Type;

export const cellReady = (needs: readonly typeof Need.Type[]) =>
  needs.every((need) => need === "model-only" || need === "read-only");
