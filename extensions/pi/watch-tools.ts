import { Effect, Schema } from "effect";

import { prompt } from "../../src/compile.ts";
import type { Prompt } from "../../src/compile.ts";
import type { HostFailure } from "./host.ts";
import type { ToolOutput } from "./tools.ts";
import { ArmWatch, ListWatches, WatchId, WatchMutation } from "./watch-contract.ts";
import type { WatchHostPort, WatchList, WatchRefused, WatchStatus } from "./watch-contract.ts";
import { untilRefusal } from "./watch-until.ts";
import type { UntilPort } from "./watch-until.ts";

const DEBUG = "read extensions/pi/watch-tools.ts in joelhooks/peons";
const FromUntil = Schema.Struct({
  fromUntil: Schema.String.check(Schema.isMinLength(1)),
  timeoutSeconds: Schema.optionalKey(ArmWatch.fields.timeoutSeconds),
});
const ArmInput = Schema.Union([ArmWatch, FromUntil]);
const ARM_SHAPE = "{ requestId, kind, condition, intervalSeconds, timeoutSeconds, notify, message, label } or { fromUntil, timeoutSeconds? }";
const MUTATION_SHAPE = '{ watchId: "<id>", requestId: "<idempotency key>" }';
const STATUS_SHAPE = '{ watchId: "<id>" }';
const LIST_SHAPE = '{ owner?: "<DID>", target?: "<Rat King name>" }';

interface WatchDeps {
  readonly host: Effect.Effect<WatchHostPort, Prompt>;
  readonly desk: Effect.Effect<string, Prompt>;
  readonly until: UntilPort;
}

const params = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, raw: unknown, tool: string, shape: string) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(raw).pipe(Effect.mapError(() => prompt({
    accepted: shape, debug: DEBUG, did: `called ${tool}`, fix: `call ${tool} with ${shape}`, tag: "ParamsRefused", why: "the arguments do not match its schema",
  })));

const refused = (tool: string, error: WatchRefused): ToolOutput => {
  const fix: Record<WatchRefused["code"], string> = {
    BadCondition: "correct the typed condition, then call watch_arm again (or keep the session watch in pi-until)",
    HostNotAllowed: "use an approved HTTPS host, then call watch_arm again; otherwise leave the watch session-local",
    IntervalTooShort: "call watch_arm with intervalSeconds at least 60, or leave the faster watch session-local",
    NotGranted: `ask the Mischief desk to verify this DID's grant, then retry ${tool}`,
    NotOwner: "call watch_list to check ownership; ask the owner or Switchboard to act",
    TooManyTargets: "call watch_arm with at most four notify.to names; put quiet recipients in notify.cc",
    UnknownWatch: "call watch_list and use a watchId from that list",
  };
  const out = prompt({ accepted: "a valid watch request on this Mischief host", debug: DEBUG, did: `called ${tool}`, fix: fix[error.code], tag: "WatchRefused", why: `${error.code}: ${error.reason}` });
  return { data: { code: error.code, tag: out.tag }, isError: true, text: out.message };
};

const finish = (tool: string, effect: Effect.Effect<ToolOutput, Prompt | HostFailure | WatchRefused>) => effect.pipe(Effect.catchTags({
  HostFailure: (error) => Effect.succeed<ToolOutput>({ data: { tag: error._tag }, isError: true, text: error.message }),
  Prompt: (error) => Effect.succeed<ToolOutput>({ data: { tag: error.tag }, isError: true, text: error.message }),
  WatchRefused: (error) => Effect.succeed(refused(tool, error)),
}));

const ok = (data: Record<string, unknown>, text: string): ToolOutput => ({ data, isError: false, text });

const showWatch = (watch: typeof WatchList.Type.watches[number]) =>
  `${watch.watchId} · ${watch.state} · ${watch.kind} · ${watch.label} · owner ${watch.owner} · to: ${watch.notify.to.join(", ") || "—"} · cc: ${watch.notify.cc.join(", ") || "—"}`;
const at = (value: number) => new Date(value).toJSON() ?? String(value);
const showStatus = ({ watch, lastCheck, cursor, evidence, firings }: typeof WatchStatus.Type) => [
  showWatch(watch),
  `Armed: ${at(watch.armedAt)} · expires: ${at(watch.expiresAt)}`,
  lastCheck === null ? "Last check: none yet" : `Last check: ${lastCheck.outcome} at ${at(lastCheck.at)} · ${lastCheck.detail}`,
  `Cursor: ${cursor ?? "—"}`,
  `Evidence (${evidence.length}):`,
  ...evidence.map((entry) => `${at(entry.at)} · ${entry.text}`),
  `Firings (${firings.length}):`,
  ...firings.map((firing) => `${at(firing.at)} · ${firing.messageId} · cursor ${firing.cursor}${firing.downgraded.length === 0 ? "" : ` · downgraded to cc: ${firing.downgraded.join(", ")}`}`),
].join("\n");

export const makeWatchTools = ({ desk, host, until }: WatchDeps) => {
  const arm = (raw: unknown) => finish("watch_arm", Effect.gen(function* armWatchGen() {
    const given = yield* params(ArmInput, raw, "watch_arm", ARM_SHAPE);
    const input = "fromUntil" in given
      ? yield* until.read(given.fromUntil, yield* desk, given.timeoutSeconds)
      : given;
    if ([...input.notify.to, ...input.notify.cc].includes("joel-phone")) {
      return yield* prompt({ accepted: "desk and agent recipients", debug: DEBUG, did: "called watch_arm", fix: "address a desk, and use message_shitrat for approved phone notifications", tag: "WatchTargetRefused", why: "watch delivery does not go through the phone's notification policy" });
    }
    if ("fromUntil" in given && !Schema.is(ArmWatch)(input)) {return yield* untilRefusal("the converted record exceeds Mischief's watch schema limits");}
    const service = yield* host;
    if ("fromUntil" in given) {yield* until.remember(input);}
    const ack = yield* service.arm(input);
    const hint = `Inspect with watch_status({ watchId: ${JSON.stringify(ack.watchId)} }).`;
    if (!("fromUntil" in given)) {return ok(ack, `Armed ${ack.watchId} · ${input.label}\n${hint}`);}
    const migration = yield* until.cancelIfRunning(given.fromUntil);
    const receipt = {
      cancelled: `Cancelled pi-until ${given.fromUntil} after Mischief acknowledged the arm.`,
      settled: `pi-until ${given.fromUntil} settled during the arm; no local cancellation was attempted. Check for an already queued or delivered wake.`,
      unconfirmed: `Could not confirm cancellation of pi-until ${given.fromUntil}. Check until({ action: "list" }); resolve any pending local wake before cancelling the duplicate.`,
    }[migration];
    return ok({ ...ack, fromUntil: given.fromUntil, migration }, `Armed ${ack.watchId} · ${input.label}\n${receipt}\n${hint}`);
  }));
  const list = (raw: unknown) => finish("watch_list", Effect.gen(function* listWatchGen() {
    const input = yield* params(ListWatches, raw, "watch_list", LIST_SHAPE);
    const result = yield* (yield* host).list(input);
    return ok(result, result.watches.length === 0 ? "No durable watches match." : [`Durable watches (${result.watches.length}):`, ...result.watches.map(showWatch)].join("\n"));
  }));
  const status = (raw: unknown) => finish("watch_status", Effect.gen(function* statusWatchGen() {
    const input = yield* params(WatchId, raw, "watch_status", STATUS_SHAPE);
    const result = yield* (yield* host).inspect(input);
    return ok(result, showStatus(result));
  }));
  const mutate = (action: "cancel" | "complete", raw: unknown) => finish(`watch_${action}`, Effect.gen(function* mutateWatchGen() {
    const input = yield* params(WatchMutation, raw, `watch_${action}`, MUTATION_SHAPE);
    const result = yield* (yield* host)[action](input);
    return ok({ ...result, watchId: input.watchId }, `${input.watchId} · ${result.state}`);
  }));
  return { watch_arm: arm, watch_cancel: (raw: unknown) => mutate("cancel", raw), watch_complete: (raw: unknown) => mutate("complete", raw), watch_list: list, watch_status: status };
};
