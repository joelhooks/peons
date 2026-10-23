// Canonical template-node schema. Moved from agent-graph-desk prototype (Tin-Tin, a6dc68b) on
// 2026-10-15 so the peons catalog holds the one copy; agent-graph-desk imports it from here.
import { Schema } from "effect";

export const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export const Thinking = Schema.Literals(thinkingLevels);

export const ModelId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/u)
);

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Slug = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,47}$/u));
const RequestId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u));

export const Pending = Schema.Struct({ note: Schema.String, owner: Schema.String, status: Schema.Literal("pending") });

export const ContextRef = Schema.Struct({
  kind: Schema.Literals(["skill", "doc", "reference-render", "model-notes"]),
  path: Schema.String,
  sha256: Sha256,
});

export const ToolGrant = Schema.Struct({
  name: Schema.String,
  timeoutSec: Schema.Int.check(Schema.isBetween({ maximum: 3600, minimum: 1 })),
  via: Schema.Literals(["rest-direct", "mcp-direct", "pi-tool", "cli"]),
});

export const CanaryCheck = Schema.Literals(["decodes-as-svg", "within-size", "mode-honoured", "jev-structure"]);

export const ReadyPoint = Schema.Struct({
  canary: Schema.Union([
    Schema.Struct({ checks: Schema.NonEmptyArray(CanaryCheck), reference: Schema.NullOr(Sha256), status: Schema.Literal("set"), theme: Schema.String }),
    Pending,
  ]),
  checkpoint: Schema.String,
});

export const ThemeRequest = Schema.Struct({
  mode: Schema.Literals(["light", "dark", "both"]),
  notes: Schema.NullOr(Schema.String),
  reference: Schema.NullOr(Schema.Struct({ path: Schema.String, sha256: Sha256, url: Schema.NullOr(Schema.String.check(Schema.isPattern(/^https:\/\/\S+$/u))) })),
  requestId: RequestId,
  size: Schema.Struct({ height: Schema.Int.check(Schema.isBetween({ maximum: 8192, minimum: 16 })), width: Schema.Int.check(Schema.isBetween({ maximum: 8192, minimum: 16 })) }),
  theme: Schema.String.check(Schema.isMinLength(1)),
});

export const ArrowRefusal = Schema.Literals(["model-not-allowed", "provider-timeout", "provider-error", "not-svg", "over-size", "mode-missed", "envelope-exhausted", "reference-unreadable"]);

export const ArrowArtifact = Schema.Struct({
  listCostUsd: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  outcome: Schema.Union([
    Schema.Struct({ generationIds: Schema.NonEmptyArray(Schema.String), kind: Schema.Literal("made"), model: ModelId, svgPath: Schema.String, svgSha256: Sha256 }),
    Schema.Struct({ kind: Schema.Literal("refused"), model: Schema.NullOr(ModelId), refusal: ArrowRefusal }),
  ]),
  requestId: RequestId,
  templateDigest: Sha256,
  tokens: Schema.Struct({ cacheRead: Schema.Int, input: Schema.Int, output: Schema.Int }),
});

export const TemplateNode = Schema.Struct({
  contract: Schema.Struct({
    input: Schema.Literal("ThemeRequest"),
    output: Schema.Literal("ArrowArtifact"),
  }),
  envelope: Schema.Struct({
    budgetUsd: Schema.Union([Schema.Number.check(Schema.isGreaterThan(0)), Pending]),
    maxForks: Schema.Int.check(Schema.isBetween({ maximum: 64, minimum: 1 })),
    perForkTimeoutSec: Schema.Int.check(Schema.isBetween({ maximum: 3600, minimum: 1 })),
  }),
  owner: Schema.String,
  profile: Schema.Struct({
    deferredTools: Schema.Array(Schema.Struct({ name: Schema.String, note: Schema.String, owner: Schema.String })),
    model: ModelId,
    postSteps: Schema.Array(Schema.Struct({ name: Schema.String, purpose: CanaryCheck, via: Schema.Literals(["script", "pi-tool"]) })),
    skills: Schema.Array(Schema.String),
    thinking: Thinking,
    tools: Schema.NonEmptyArray(ToolGrant),
  }),
  ready: ReadyPoint,
  rewarm: Schema.Struct({
    check: Schema.String,
    digestInputs: Schema.NonEmptyArray(Schema.Literals(["quiver-models", "skill-hashes", "tool-list", "reference-hashes", "model-id"])),
  }),
  schema: Schema.Literal("agent-graph.template-node.v0.1"),
  template: Slug,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  warmup: Schema.Union([Schema.NonEmptyArray(ContextRef), Pending]),
});

export type TemplateNode = typeof TemplateNode.Type;

export const frozen = (node: TemplateNode) =>
  !Schema.is(Pending)(node.warmup) && !Schema.is(Pending)(node.ready.canary) && !Schema.is(Pending)(node.envelope.budgetUsd);
