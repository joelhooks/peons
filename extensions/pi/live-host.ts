// The live run host: Mischief's capabilities over HTTP, each call signed as the calling desk. The
// protocol matches agent-graph-desk's prototype/src/shadow/remote.ts: POST /<capability> with a JSON
// body and an ES256 service token whose iss is the desk's DID, aud the Mischief worker and lxm
// sh.mschf.mischief.<capability>. The signing is WebCrypto, low-S normalised as Rat King's
// envelope/es256 does, because @rat-king/mailbox-client is not a dependency here.
//
// The desk's identity is leased from agent-secrets by name (PEONS_IDENTITY_SECRET) on first use and
// held in memory for at most ten minutes. Its value is never logged or returned.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

import { Effect, Result, Schema } from "effect";

import { prompt } from "../../src/compile.ts";
import type { Prompt } from "../../src/compile.ts";
import { RunReport } from "../../src/run-report.ts";
import { AnswerRefused, HostFailure, PlanRefused, ReplyRefused, UnknownRun } from "./host.ts";
import type { RunHostPort } from "./host.ts";

export const DEFAULT_AUDIENCE = "did:web:mischief.worker.pi.ratking-fleet.invalid#mischief";
const DEBUG = "read extensions/pi/live-host.ts in joelhooks/peons";

const Endpoint = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
    } catch {
      return false;
    }
  }),
);

const PrivateJwk = Schema.Struct({ crv: Schema.Literal("P-256"), d: Schema.String, kty: Schema.Literal("EC"), x: Schema.String, y: Schema.String });
export const Identity = Schema.Struct({ agreement: PrivateJwk, did: Schema.String.check(Schema.isPattern(/^did:web:/u)), signing: PrivateJwk });

export interface Signer {
  readonly did: string;
  readonly key: CryptoKey;
}

export const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

const P256_ORDER = 0xff_ff_ff_ff_00_00_00_00_ff_ff_ff_ff_ff_ff_ff_ff_bc_e6_fa_ad_a7_17_9e_84_f3_b9_ca_c2_fc_63_25_51n;
const scalar = (bytes: Uint8Array) => BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
const scalarBytes = (value: bigint) => Uint8Array.from(Buffer.from(value.toString(16).padStart(64, "0"), "hex"));

export const lowS = (signature: Uint8Array) => {
  const s = scalar(signature.subarray(32));
  return Uint8Array.from([...signature.subarray(0, 32), ...scalarBytes(s > P256_ORDER / 2n ? P256_ORDER - s : s)]);
};

export const serviceToken = async (signer: Signer, claims: { readonly aud: string; readonly lxm: string; readonly now: number }) => {
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: "#atproto", typ: "JWT" })));
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ aud: claims.aud, exp: claims.now + 60, iat: claims.now, iss: signer.did, jti: randomUUID(), lxm: claims.lxm })));
  const signature = new Uint8Array(await crypto.subtle.sign({ hash: "SHA-256", name: "ECDSA" }, signer.key, new TextEncoder().encode(`${header}.${payload}`)));
  return `${header}.${payload}.${base64url(lowS(signature))}`;
};

const failure = (did: string, why: string, fix: string) =>
  new HostFailure({ message: prompt({ accepted: "a Mischief worker that answers its capability schema", debug: DEBUG, did, fix, tag: "HostFailure", why }).message });

const Declared = Schema.Union([
  Schema.TaggedStruct("UnknownRun", { runId: Schema.String }),
  Schema.TaggedStruct("PlanRefused", { errors: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("ReplyRefused", { reason: Schema.String, replyTo: Schema.String }),
  Schema.TaggedStruct("AnswerRefused", { reason: Schema.String, runId: Schema.String }),
]);
const decodeDeclared = Schema.decodeUnknownOption(Declared);
const decodeReport = Schema.decodeUnknownResult(RunReport);

export interface LiveOptions {
  readonly endpoint: string;
  readonly audience: string;
  readonly signer: Effect.Effect<Signer, Prompt>;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
}

const unexpected = (name: string) => (error: { readonly _tag: string }) => Effect.fail(failure(`called Mischief ${name}`, `the worker answered ${error._tag}, which ${name} does not declare`, "retry the same call"));

export const liveRunHost = (options: LiveOptions): RunHostPort => {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const call = (name: "submitPlan" | "inspectRun" | "deliverReply" | "answerRun" | "abortRun", input: unknown) =>
    Effect.gen(function* callGen() {
      const did = `called Mischief ${name}`;
      const signer = yield* options.signer.pipe(Effect.mapError((refusal) => new HostFailure({ message: refusal.message })));
      const token = yield* Effect.tryPromise({
        catch: () => failure(did, "the desk's signing key could not sign a service token", "lease the desk identity again and retry the call"),
        try: async () => await serviceToken(signer, { aud: options.audience, lxm: `sh.mschf.mischief.${name}`, now: now() }),
      });
      const response = yield* Effect.tryPromise({
        catch: () => failure(did, "the request did not reach the worker", "check MISCHIEF_HOST and the tailnet connection, then retry the same call"),
        try: async (signal) =>
          await options.fetch(new URL(`/${name}`, options.endpoint), {
            body: JSON.stringify(input),
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            method: "POST",
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          }),
      });
      const body: unknown = yield* Effect.tryPromise({
        catch: () => failure(did, `the worker returned non-JSON (HTTP ${response.status})`, "check that MISCHIEF_HOST points at a Mischief worker"),
        try: async (): Promise<unknown> => await response.json(),
      });
      if (!response.ok) {
        const declared = decodeDeclared(body);
        if (declared._tag === "Some") {
          const {value} = declared;
          if (value._tag === "UnknownRun") {return yield* new UnknownRun({ runId: value.runId });}
          if (value._tag === "PlanRefused") {return yield* new PlanRefused({ errors: value.errors });}
          if (value._tag === "AnswerRefused") {return yield* new AnswerRefused({ reason: value.reason, runId: value.runId });}
          return yield* new ReplyRefused({ reason: value.reason, replyTo: value.replyTo });
        }
        return yield* failure(did, `the worker refused the call (HTTP ${response.status})`, response.status === 401 || response.status === 403 ? "check that this desk's DID is on the worker's caller list" : "inspect the worker version and capability projection");
      }
      const report = decodeReport(body);
      if (Result.isFailure(report)) {return yield* failure(did, "the worker answered outside the RunReport schema", "check the worker and peons pins");}
      return report.success;
    });

  return {
    abort: (runId, supersededBy, reason) => call("abortRun", { reason, runId, supersededBy }).pipe(Effect.catchTags({ AnswerRefused: unexpected("abortRun"), PlanRefused: unexpected("abortRun"), ReplyRefused: unexpected("abortRun") })),
    answer: (runId, reply) => call("answerRun", { reply, runId }).pipe(Effect.catchTags({ PlanRefused: unexpected("answerRun"), ReplyRefused: unexpected("answerRun") })),
    deliver: (line) =>
      call("deliverReply", line).pipe(Effect.catchTags({ AnswerRefused: unexpected("deliverReply"), PlanRefused: unexpected("deliverReply"), UnknownRun: (unknown) => Effect.fail(new ReplyRefused({ reason: `run ${unknown.runId} is unknown`, replyTo: line.replyTo })) })),
    inspect: (runId) => call("inspectRun", { runId }).pipe(Effect.catchTags({ AnswerRefused: unexpected("inspectRun"), PlanRefused: unexpected("inspectRun"), ReplyRefused: unexpected("inspectRun") })),
    submit: (runId, plan, docs) => call("submitPlan", { docs, plan, runId }).pipe(Effect.catchTags({ AnswerRefused: unexpected("submitPlan"), ReplyRefused: unexpected("submitPlan"), UnknownRun: unexpected("submitPlan") })),
  };
};

// What the live host needs from the environment, refused as a 4-line prompt when it is missing.
export interface LiveEnv {
  readonly endpoint: string;
  readonly secretName: string;
  readonly audience: string;
}

export const liveEnv = (env: Readonly<Record<string, string | undefined>>, tool: string): LiveEnv | Prompt => {
  const endpoint = env.MISCHIEF_HOST;
  const secretName = env.PEONS_IDENTITY_SECRET;
  const missing = [...(endpoint === undefined || endpoint === "" ? ["MISCHIEF_HOST"] : []), ...(secretName === undefined || secretName === "" ? ["PEONS_IDENTITY_SECRET"] : [])];
  const accepted = "MISCHIEF_HOST=<the Mischief worker origin, like http://host:port/> and PEONS_IDENTITY_SECRET=<the agent-secrets name of this desk's Rat King identity>";
  if (missing.length > 0 || endpoint === undefined || secretName === undefined)
    {return prompt({ accepted, debug: DEBUG, did: `called ${tool}`, fix: `export ${missing.map((name) => `${name}=…`).join(" ")} in the desk's environment, /reload, then call ${tool} again`, tag: "HostUnset", why: `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set` });}
  if (Result.isFailure(Schema.decodeResult(Endpoint)(endpoint)))
    {return prompt({ accepted, debug: DEBUG, did: `called ${tool}`, fix: `set MISCHIEF_HOST to the worker origin ending in /, /reload, then call ${tool} again`, tag: "HostUnset", why: "MISCHIEF_HOST is not an origin without credentials, path, query or fragment" });}
  return { audience: env.MISCHIEF_AUDIENCE ?? DEFAULT_AUDIENCE, endpoint, secretName };
};

const leaseRefused = (why: string) =>
  prompt({ accepted: "an agent-secrets name whose value is this desk's Rat King identity JSON", debug: DEBUG, did: "leased the desk identity for a Mischief call", fix: "check PEONS_IDENTITY_SECRET with secrets_status, /reload, then retry the call", tag: "IdentityUnavailable", why });

export const leaseWithSecretsCli = (name: string): Effect.Effect<string, Prompt> =>
  Effect.callback<string, Prompt>((resume) => {
    execFile("secrets", ["lease", name, "--ttl", "15m", "--client-id", "peons-pi"], { maxBuffer: 64 * 1024, timeout: 15_000 }, (failed, stdout) => {
      resume(failed === null && stdout.length > 0 ? Effect.succeed(stdout) : Effect.fail(leaseRefused("agent-secrets did not lease it")));
    });
  });

// Leases, decodes and imports the identity once, then reuses it for ten minutes.
export const leasedSigner = (name: string, lease: (name: string) => Effect.Effect<string, Prompt> = leaseWithSecretsCli, clock: () => number = Date.now): Effect.Effect<Signer, Prompt> => {
  let held: { readonly signer: Signer; readonly until: number } | null = null;
  return Effect.gen(function* leasedSignerGen() {
    if (held !== null && held.until > clock()) {return held.signer;}
    const text = yield* lease(name);
    const identity = Schema.decodeResult(Schema.fromJsonString(Identity))(text.trim());
    if (Result.isFailure(identity)) {return yield* leaseRefused("the leased value is not a Rat King identity");}
    const key = yield* Effect.tryPromise({
      catch: () => leaseRefused("the identity has no usable ES256 signing key"),
      try: async () => await crypto.subtle.importKey("jwk", identity.success.signing, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    });
    const signer = { did: identity.success.did, key };
    held = { signer, until: clock() + 10 * 60_000 };
    return signer;
  });
};
