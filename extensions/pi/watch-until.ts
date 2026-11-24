import { createHash } from "node:crypto";

import { Effect, Result, Schema } from "effect";

import { prompt } from "../../src/compile.ts";
import type { Prompt } from "../../src/compile.ts";
import { PeonState } from "./watch-contract.ts";
import type { ArmWatch, WatchCondition } from "./watch-contract.ts";

// Recognize a small grammar, not general shell. Never execute the stored command.
const Curl = /^curl -s -o \/dev\/null -w '%\{http_code\}' (?<quote>["']?)(?<url>https:\/\/[\w./:%~-]+)\k<quote>$/u;
const StatusTest = /^(?<test>test|\[|\[\[) "\$\((?<command>[^\r\n]+)\)" (?:=|-eq) (?<quote>["']?)(?<status>[1-4]\d\d)\k<quote>(?<end>| \]| \]\])$/u;
const TestEnd = new Map([["test", ""], ["[", " ]"], ["[[", " ]]"]]);
const CheckRun = /^shitrat checks (?<repo>[\w-][\w.-]*\/[\w-][\w.-]*) (?<sha>[a-f0-9]{7,40}) \| grep (?:-q )?'(?<check>[\w /:-]+?)(?:\.\*| )completed'$/u;
const PeonPoll = /^(?:peon_status|inspectPeon) (?<id>[a-z0-9][a-z0-9-]{0,39}) \| jq -e '(?:\.state == "(?<state>[a-z]+)"(?<both> and \.pending == null)?|(?<pending>\.pending == null))'$/u;

type Conversion = { readonly condition: WatchCondition } | { readonly reason: string };

const curlStatus = (command: string): WatchCondition | undefined => {
  const test = StatusTest.exec(command)?.groups;
  if (test === undefined || test.end !== TestEnd.get(test.test ?? "")) {return undefined;}
  const url = Curl.exec(test.command ?? "")?.groups?.url;
  if (url === undefined) {return undefined;}
  const parsed = URL.parse(url);
  if (parsed === null || parsed.port !== "") {return undefined;}
  return { expect: { status: Number(test.status) }, type: "http", url };
};

const githubCheck = (command: string): WatchCondition | undefined => {
  const { repo, sha, check } = CheckRun.exec(command)?.groups ?? {};
  if (repo === undefined || sha === undefined || check === undefined || check.trim() === "") {return undefined;}
  return {
    expect: { equals: "completed", jsonPath: `$.check_runs[?(@.name==${JSON.stringify(check.trim())})].status`, status: 200 },
    type: "http",
    url: `https://api.github.com/repos/${repo}/commits/${sha}/check-runs`,
  };
};

const peonCheck = (command: string): WatchCondition | undefined => {
  const { id, state, pending, both } = PeonPoll.exec(command)?.groups ?? {};
  if (id === undefined || (state !== undefined && !Schema.is(PeonState)(state))) {return undefined;}
  return { expect: { ...(state === undefined ? {} : { state }), ...(pending === undefined && both === undefined ? {} : { pendingClear: true }) }, peonId: id, type: "peon" };
};

export const convertUntilCondition = (raw: string): Conversion => {
  const command = raw.trim();
  const condition = curlStatus(command) ?? githubCheck(command) ?? peonCheck(command);
  if (condition !== undefined) {return { condition };}
  if (/\b(?:herdr|tmux|screen|capture-pane|herdr_watch)\b/u.test(command)) {return { reason: "reads a local pane" };}
  if (/(?:\b(?:pgrep|pidof|ps)\b|\bkill\s+-0\b|\/proc\/)/u.test(command)) {return { reason: "reads a local process" };}
  if (/^(?:cat|grep|rg|stat|tail|head)\b|(?:^|[\s;&|])(?:test|\[\[?)\s+-[defrswx]\b|\s(?:\.\.?\/|\/(?!dev\/null\b))/u.test(command)) {
    return { reason: "reads a local path" };
  }
  return { reason: "the shell predicate is not a supported curl status, named GitHub check, or peon poll" };
};

const ContextRefs = Schema.Array(Schema.Unknown);
const Snapshot = Schema.Struct({ contextRefs: ContextRefs, instruction: Schema.String, quickRef: Schema.String });
const Receipt = Schema.Struct({
  deliveries: Schema.Int,
  deliveryPending: Schema.Boolean,
  expiresAt: Schema.optionalKey(Schema.String),
  id: Schema.String,
  intervalMs: Schema.Int,
  kind: Schema.Literals(["until", "recurring"]),
  label: Schema.String,
  status: Schema.String,
  wake: Schema.Literals(["agent", "notify"]),
});
const Journal = Schema.Struct({
  sessionId: Schema.String,
  v: Schema.Literal(3),
  watches: Schema.Array(Schema.Struct({
    definition: Schema.Struct({
      first: Schema.optionalKey(Schema.Literals(["now", "afterInterval"])),
      gate: Schema.optionalKey(Schema.Struct({ command: Schema.String })),
      snapshot: Schema.optionalKey(Snapshot),
    }),
    facts: Schema.Struct({ id: Schema.String }),
  })),
});
const StartInput = Schema.Struct({
  action: Schema.Literals(["start", "repeat"]),
  condition: Schema.optionalKey(Schema.String),
  contextRefs: Schema.optionalKey(ContextRefs),
  immediate: Schema.optionalKey(Schema.Boolean),
  instruction: Schema.optionalKey(Schema.String),
  quickRef: Schema.optionalKey(Schema.String),
});
interface Definition {
  readonly command?: string | undefined;
  readonly immediate: boolean;
  readonly contextRefs?: readonly unknown[] | undefined;
  readonly instruction?: string | undefined;
  readonly quickRef?: string | undefined;
}
interface UntilResult { readonly details?: unknown; readonly isError?: boolean }
export interface UntilContext {
  readonly appendEntry: (type: string, data: unknown) => void;
  readonly sessionManager: {
    readonly getSessionId: () => string;
    readonly getBranch: () => readonly { readonly type: string; readonly customType?: string; readonly data?: unknown }[];
  };
  readonly executeTool: (name: "until", args: { readonly action: "list" } | { readonly action: "cancel"; readonly id: string }) => Promise<UntilResult>;
}
export interface UntilPort {
  readonly read: (id: string, desk: string, timeoutSeconds?: number) => Effect.Effect<typeof ArmWatch.Type, Prompt>;
  readonly cancelIfRunning: (id: string) => Effect.Effect<"cancelled" | "settled" | "unconfirmed">;
  readonly remember: (input: typeof ArmWatch.Type) => Effect.Effect<void, Prompt>;
}

export const untilRefusal = (reason: string) => prompt({
  accepted: "an active, unfired pi-until watch with a supported predicate and no session-local context",
  debug: "read extensions/pi/watch-until.ts in joelhooks/peons",
  did: "called watch_arm with fromUntil",
  fix: "leave it in pi-until, or call watch_arm with an explicit typed condition and a secret-free message",
  tag: "UntilNotMigrated",
  why: `${reason}; stays in pi-until`,
});

const journalDefinition = (session: UntilContext["sessionManager"], id: string): Definition | undefined => {
  // No live definition reader in pi-until. Read the documented suspension entry through
  // Pi's read-only session-file API. Never read unrelated sessions or write their records.
  for (const entry of session.getBranch().toReversed()) {
    if (entry.type !== "custom" || entry.customType !== "pi-until-suspended") {continue;}
    const parsed = Schema.decodeUnknownResult(Journal)(entry.data);
    if (Result.isFailure(parsed) || parsed.success.sessionId !== session.getSessionId()) {continue;}
    const stored = parsed.success.watches.find((watch) => watch.facts.id === id);
    if (stored !== undefined) {
      const { gate, first, snapshot } = stored.definition;
      return { command: gate?.command, immediate: first === "now", ...snapshot };
    }
  }
  return undefined;
};

const LiveList = Schema.Struct({ watches: Schema.Array(Receipt) });
const Cancelled = Schema.Struct({ id: Schema.String, status: Schema.Literal("cancelled") });

const listWatches = (ctx: UntilContext): Effect.Effect<typeof LiveList.Type, Prompt> => Effect.gen(function* listUntilGen() {
  const result = yield* Effect.tryPromise({ catch: () => untilRefusal("the session's until list call failed"), try: async () => await ctx.executeTool("until", { action: "list" }) });
  const decoded = Schema.decodeUnknownResult(LiveList)(result.details);
  if (result.isError === true || Result.isFailure(decoded)) {return yield* untilRefusal("the session's until list did not return live receipts");}
  return decoded.success;
});

const ATTEMPT_ENTRY = "peons-watch-arm-attempt";
const Attempt = Schema.Struct({ requestId: Schema.String, timeoutSeconds: Schema.Int.check(Schema.isGreaterThan(0)) });
const savedTimeout = (ctx: UntilContext, requestId: string): number | null => {
  for (const entry of ctx.sessionManager.getBranch().toReversed()) {
    if (entry.type !== "custom" || entry.customType !== ATTEMPT_ENTRY) {continue;}
    const parsed = Schema.decodeUnknownResult(Attempt)(entry.data);
    if (Result.isSuccess(parsed) && parsed.success.requestId === requestId) {return parsed.success.timeoutSeconds;}
  }
  return null;
};

const remainingSeconds = (expiresAt: string | undefined, now: number, timeout: number | undefined) => {
  if (expiresAt === undefined) {return timeout;}
  const remaining = Math.floor((Date.parse(expiresAt) - now) / 1000);
  return Math.min(remaining, timeout ?? remaining);
};

const migratableCondition = (receipt: typeof Receipt.Type, definition: Definition) => {
  if (definition.immediate) {return { reason: "it requests an immediate turn wake" };}
  if (receipt.deliveries > 0 || receipt.deliveryPending) {return { reason: "it already delivered or has a pending wake, and its cursor cannot be carried over" };}
  if ((definition.contextRefs?.length ?? 0) > 0) {return { reason: "it has contextRefs, which the durable v1 message cannot carry" };}
  if (definition.command === undefined) {return { reason: "it has no predicate" };}
  return convertUntilCondition(definition.command);
};

export const makeUntilReader = (now: () => number = Date.now) => {
  const definitions = new Map<string, Definition>();
  const clear = () => {definitions.clear();};
  // Pi's tool_result event includes exact inputs and receipts for both direct and nested calls.
  // The journal fallback covers watches restored on reload or graceful recovery.
  const observe = (event: { readonly toolName: string; readonly input: unknown } & UntilResult) => {
    if (event.toolName !== "until" || event.isError === true) {return;}
    const receipt = Schema.decodeUnknownResult(Receipt)(event.details);
    if (Result.isFailure(receipt)) {return;}
    if (receipt.success.status !== "running") {definitions.delete(receipt.success.id); return;}
    const input = Schema.decodeUnknownResult(StartInput)(event.input);
    if (Result.isSuccess(input)) {
      const { condition, contextRefs, immediate, instruction, quickRef } = input.success;
      definitions.set(receipt.success.id, { command: condition, contextRefs, immediate: immediate === true, instruction, quickRef });
    }
  };
  const port = (ctx: UntilContext): UntilPort => ({
    cancelIfRunning: (id) => Effect.gen(function* cancelUntilGen() {
      const { watches } = yield* listWatches(ctx);
      const active = watches.find((watch) => watch.id === id && watch.status === "running");
      if (active === undefined) {return "settled" as const;}
      if (active.deliveryPending || active.deliveries > 0) {return "unconfirmed" as const;}
      const result = yield* Effect.tryPromise({ catch: () => untilRefusal("the post-arm until cancel call failed"), try: async () => await ctx.executeTool("until", { action: "cancel", id }) });
      const decoded = Schema.decodeUnknownResult(Cancelled)(result.details);
      return result.isError !== true && Result.isSuccess(decoded) && decoded.success.id === id ? "cancelled" as const : "unconfirmed" as const;
    }).pipe(Effect.orElseSucceed(() => "unconfirmed" as const)),
    read: (id, desk, timeout) => Effect.gen(function* readUntilGen() {
      const { watches } = yield* listWatches(ctx);
      const receipt = watches.find((watch) => watch.id === id && watch.status === "running");
      if (receipt === undefined) {return yield* untilRefusal("that id is not running in this session (including handoff-pending watches)");}
      const definition = definitions.get(id) ?? journalDefinition(ctx.sessionManager, id);
      if (definition === undefined) {return yield* untilRefusal("no live start or suspension record has the predicate; /reload to journal the active watch before retrying");}
      const converted = migratableCondition(receipt, definition);
      if ("reason" in converted) {return yield* untilRefusal(converted.reason);}
      const intervalSeconds = Math.ceil(receipt.intervalMs / 1000);
      if (intervalSeconds < 60) {return yield* untilRefusal("its interval is shorter than Mischief's 60s minimum");}
      const timeoutSeconds = remainingSeconds(receipt.expiresAt, now(), timeout);
      if (timeoutSeconds === undefined) {return yield* untilRefusal("it has no expiry; retry fromUntil with timeoutSeconds to set one");}
      if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {return yield* untilRefusal("its expiry is missing, invalid or too close");}
      const summary = definition.quickRef ?? receipt.label;
      if (summary.length > 280) {return yield* untilRefusal("its quickRef or label exceeds Mischief's 280-character summary limit");}
      const requestId = `until-${createHash("sha256").update(JSON.stringify([ctx.sessionManager.getSessionId(), id])).digest("hex").slice(0, 40)}`;
      return {
        condition: converted.condition, intervalSeconds, kind: receipt.kind === "recurring" ? "repeat" : "once", label: receipt.label,
        message: { body: definition.instruction ?? receipt.label, summary },
        notify: receipt.wake === "agent" ? { cc: [], to: [desk] } : { cc: [desk], to: [] },
        requestId,
        timeoutSeconds: savedTimeout(ctx, requestId) ?? timeoutSeconds,
      };
    }),
    remember: ({ requestId, timeoutSeconds }) => Effect.try({
      catch: () => untilRefusal("could not journal the retry key and timeout before arming"),
      try: () => {
        // The worker compares the complete payload on replay. Freeze the one field that
        // would drift between retries, without copying instructions or shell into our journal.
        const previous = savedTimeout(ctx, requestId);
        if (previous === null) {ctx.appendEntry(ATTEMPT_ENTRY, { requestId, timeoutSeconds });}
        else if (previous !== timeoutSeconds) {throw new Error("a concurrent migration saved a different timeout");}
      },
    }),
  });
  return { clear, observe, port };
};
