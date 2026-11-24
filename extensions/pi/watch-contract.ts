// Pi's wire projection of Mischief durable watches v1. The worker owns grants, the host
// allowlist, scheduling, and delivery. Keep client decoding at the capability boundary.
import { Schema } from "effect";
import type { Effect } from "effect";

import type { HostFailure } from "./host.ts";

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const Name = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?$/u), Schema.isMaxLength(128));
const Owner = Schema.String.check(Schema.isPattern(/^did:[a-z0-9]+:\S+$/u));
const Id = Schema.String.check(Schema.isPattern(/^watch-[a-f0-9]{64}$/u));
const RequestId = NonEmpty.check(Schema.isMaxLength(512));
const State = Schema.Literals(["armed", "checking", "fired", "done", "cancelled", "expired"]);
const Kind = Schema.Literals(["once", "repeat"]);
export const PeonState = Schema.Literals(["spawned", "attaching", "running", "idle", "suspended", "hibernated", "destroyed"]);
export const PeonId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/u));
export const HttpCondition = Schema.Struct({
  expect: Schema.Struct({
    equals: Schema.optionalKey(Schema.Json),
    jsonPath: Schema.optionalKey(NonEmpty.check(Schema.isMaxLength(256))),
    regex: Schema.optionalKey(NonEmpty.check(Schema.isMaxLength(256))),
    status: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ maximum: 499, minimum: 100 }))),
  }),
  type: Schema.Literal("http"),
  url: NonEmpty.check(Schema.isMaxLength(2048)),
});
export const PeonCondition = Schema.Struct({
  expect: Schema.Struct({ pendingClear: Schema.optionalKey(Schema.Literal(true)), state: Schema.optionalKey(PeonState) }),
  peonId: PeonId,
  type: Schema.Literal("peon"),
});
export type WatchCondition = typeof HttpCondition.Type | typeof PeonCondition.Type;

const Notify = Schema.Struct({ cc: Schema.Array(Name), to: Schema.Array(Name) });
export const ArmWatch = Schema.Struct({
  condition: Schema.Union([HttpCondition, PeonCondition]),
  intervalSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
  kind: Kind,
  label: NonEmpty.check(Schema.isMaxLength(256)),
  message: Schema.Struct({ body: Schema.String.check(Schema.isMaxLength(20_000)), summary: Schema.String.check(Schema.isMaxLength(280)) }),
  notify: Notify,
  requestId: RequestId,
  timeoutSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
});
export const ArmAck = Schema.Struct({ state: Schema.Literal("armed"), watchId: Id });
export const ListWatches = Schema.Struct({ owner: Schema.optionalKey(Owner), target: Schema.optionalKey(Name) });
const WatchSummary = Schema.Struct({
  armedAt: Schema.Finite,
  expiresAt: Schema.Finite,
  kind: Kind,
  label: ArmWatch.fields.label,
  notify: Notify,
  owner: Owner,
  state: State,
  watchId: Id,
});
export const WatchList = Schema.Struct({ watches: Schema.Array(WatchSummary) });
export const WatchId = Schema.Struct({ watchId: Id });
export const WatchMutation = Schema.Struct({ requestId: RequestId, ...WatchId.fields });
export const MutationAck = Schema.Struct({ state: State });
const Check = Schema.Struct({ at: Schema.Finite, detail: Schema.String, outcome: Schema.Literals(["true", "false", "checkError"]) });
const Cursor = Schema.NullOr(Schema.String);
export const WatchStatus = Schema.Struct({
  cursor: Cursor,
  evidence: Schema.Array(Schema.Struct({ at: Schema.Finite, text: Schema.String })),
  firings: Schema.Array(Schema.Struct({ at: Check.fields.at, cursor: Schema.String, downgraded: Schema.Array(Name), messageId: NonEmpty })),
  lastCheck: Schema.NullOr(Check),
  watch: Schema.Struct({ ...WatchSummary.fields, condition: ArmWatch.fields.condition, intervalSeconds: ArmWatch.fields.intervalSeconds, message: ArmWatch.fields.message, timeoutSeconds: ArmWatch.fields.timeoutSeconds }),
});

export class WatchRefused extends Schema.TaggedError<WatchRefused, { readonly brand: unique symbol }>()("WatchRefused", {
  code: Schema.Literals(["BadCondition", "HostNotAllowed", "TooManyTargets", "IntervalTooShort", "NotOwner", "UnknownWatch", "NotGranted"]),
  reason: Schema.String,
}) {}

export interface WatchHostPort {
  readonly arm: (input: typeof ArmWatch.Type) => Effect.Effect<typeof ArmAck.Type, WatchRefused | HostFailure>;
  readonly list: (input: typeof ListWatches.Type) => Effect.Effect<typeof WatchList.Type, WatchRefused | HostFailure>;
  readonly inspect: (input: typeof WatchId.Type) => Effect.Effect<typeof WatchStatus.Type, WatchRefused | HostFailure>;
  readonly cancel: (input: typeof WatchMutation.Type) => Effect.Effect<typeof MutationAck.Type, WatchRefused | HostFailure>;
  readonly complete: (input: typeof WatchMutation.Type) => Effect.Effect<typeof MutationAck.Type, WatchRefused | HostFailure>;
}
