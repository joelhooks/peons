import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { leasedSigner, liveEnv, liveRunHost } from "../extensions/pi/live-host.ts";
import { Prompt } from "../src/compile.ts";
import { CatalogEntry } from "../src/contract.ts";
import { RoutingTable } from "../src/routing.ts";
import { ThinkTemplate } from "../src/think-template.ts";
import { loadCatalog } from "../extensions/pi/catalog.ts";
import { ROOT, bodyText, catalog, fakeHost, jsonResponse, toolsWith, urlText } from "./support.ts";

const P256_HALF = 0xff_ff_ff_ff_00_00_00_00_ff_ff_ff_ff_ff_ff_ff_ff_bc_e6_fa_ad_a7_17_9e_84_f3_b9_ca_c2_fc_63_25_51n / 2n;
const fromB64 = (text: string) => Buffer.from(text, "base64url");

const jwk = async (key: CryptoKey) => {
  const { crv, d, kty, x, y } = await crypto.subtle.exportKey("jwk", key);
  return { crv, d, kty, x, y };
};

const identity = async () => {
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const agreement = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return { publicKey: signing.publicKey, text: JSON.stringify({ agreement: await jwk(agreement.privateKey), did: "did:web:agent-graph.desk.pi.ratking-fleet.invalid", signing: await jwk(signing.privateKey) }) };
};

const report = { docs: {}, planId: "peon-x", planVersion: 1, runId: "run-abc", status: "running", transitions: 0, value: "work" };

describe("live run host", () => {
  it("signs each capability call as the desk's DID with a verifiable low-S ES256 service token", async () => {
    const { text, publicKey } = await identity();
    let leases = 0;
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const host = liveRunHost({
      audience: "did:web:mischief.worker.pi.ratking-fleet.invalid#mischief",
      endpoint: "http://mischief.example:28000/",
      fetch: async (url, init) => {
        seen.push({ init, url: urlText(url) });
        return await jsonResponse(report);
      },
      now: () => 1000,
      signer: leasedSigner("rat_king_desk_identity", () => Effect.sync(() => {
        leases += 1;
        return text;
      })),
    });
    expect(await Effect.runPromise(host.inspect("run-abc"))).toMatchObject({ runId: "run-abc", status: "running" });
    await Effect.runPromise(host.deliver({ body: "yes", replyTo: "run-abc/work#1", runId: "run-abc" }));
    await Effect.runPromise(host.answer("run-abc", "pass"));
    expect(leases).toBe(1);
    expect(seen.map(({ url }) => url)).toEqual(["http://mischief.example:28000/inspectRun", "http://mischief.example:28000/deliverReply", "http://mischief.example:28000/answerRun"]);
    expect(JSON.parse(bodyText(seen[2]?.init))).toEqual({ reply: "pass", runId: "run-abc" });
    const headers = new Headers(seen[0]?.init?.headers);
    const [header, payload, signature] = (headers.get("authorization") ?? "").replace(/^Bearer /u, "").split(".");
    expect(JSON.parse(fromB64(header ?? "").toString())).toEqual({ alg: "ES256", kid: "#atproto", typ: "JWT" });
    expect(JSON.parse(fromB64(payload ?? "").toString())).toMatchObject({ aud: "did:web:mischief.worker.pi.ratking-fleet.invalid#mischief", exp: 1060, iat: 1000, iss: "did:web:agent-graph.desk.pi.ratking-fleet.invalid", lxm: "sh.mschf.mischief.inspectRun" });
    const bytes = fromB64(signature ?? "");
    expect(BigInt(`0x${bytes.subarray(32).toString("hex")}`) <= P256_HALF).toBe(true);
    expect(await crypto.subtle.verify({ hash: "SHA-256", name: "ECDSA" }, publicKey, bytes, new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
    expect(seen[0]?.init?.method).toBe("POST");
    expect(seen[0]?.init?.redirect).toBe("error");
  });

  it("maps a declared UnknownRun failure, and refuses a non-identity lease without echoing it", async () => {
    const { text } = await identity();
    const host = liveRunHost({ audience: "aud", endpoint: "http://m.example/", fetch: async () => await jsonResponse({ _tag: "UnknownRun", runId: "run-x" }, 422), signer: leasedSigner("n", () => Effect.succeed(text)) });
    const exit = await Effect.runPromiseExit(host.inspect("run-x"));
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("UnknownRun");
    const declared = (body: unknown) => liveRunHost({ audience: "aud", endpoint: "http://m.example/", fetch: async () => await jsonResponse(body, 422), signer: leasedSigner("n", () => Effect.succeed(text)) });
    const refused = await Effect.runPromiseExit(declared({ _tag: "PlanRefused", errors: ["peon: needs on.done"] }).submit("run-x", { defaults: { agent: {} }, envelope: { maxAgents: 1, maxDepth: 1, maxSteps: 2, maxThinking: "low", models: ["sol"], names: [], thresholds: { judge: 0.8 } }, id: "run-x", machine: { id: "run-x", initial: "done", states: { done: { type: "final" } } } }, {}));
    expect(Exit.isFailure(refused) && JSON.stringify(refused.cause)).toContain("needs on.done");
    const answer = await Effect.runPromiseExit(declared({ _tag: "AnswerRefused", reason: "not an option", runId: "run-x" }).answer("run-x", "maybe"));
    expect(Exit.isFailure(answer) && JSON.stringify(answer.cause)).toContain("AnswerRefused");
    const bad = await Effect.runPromiseExit(leasedSigner("n", () => Effect.succeed("not-an-identity-SECRETVALUE")));
    expect(Exit.isFailure(bad)).toBe(true);
    expect(Exit.isFailure(bad) && JSON.stringify(bad.cause)).not.toContain("SECRETVALUE");
  });

  it("refuses with a 4-line prompt when MISCHIEF_HOST or PEONS_IDENTITY_SECRET is missing or malformed", () => {
    for (const env of [{}, { MISCHIEF_HOST: "http://m.example/" }, { PEONS_IDENTITY_SECRET: "n" }, { MISCHIEF_HOST: "http://user:pw@m.example/path", PEONS_IDENTITY_SECRET: "n" }]) {
      const out = liveEnv(env, "peon_run");
      expect(out).toBeInstanceOf(Prompt);
      expect(out instanceof Prompt && out.message.split("\n").map((line) => line.split(":")[0])).toEqual(["HostUnset", "Accepted", "Fix", "Debug"]);
    }
    expect(liveEnv({ MISCHIEF_HOST: "http://m.example/", PEONS_IDENTITY_SECRET: "n" }, "peon_run")).toEqual({ audience: "did:web:mischief.worker.pi.ratking-fleet.invalid#mischief", endpoint: "http://m.example/", secretName: "n" });
  });
});

describe("catalog", () => {
  it("seam: the live routing.json, catalog.json and templates load and decode", async () => {
    const live = await Effect.runPromise(loadCatalog(ROOT));
    expect(Schema.is(RoutingTable)(live.routing)).toBe(true);
    expect(live.entries.every(Schema.is(CatalogEntry))).toBe(true);
    expect(live.think.every((loaded) => Schema.is(ThinkTemplate)(loaded.spec))).toBe(true);
  });

  it("peon_catalog lists catalog entries as runnable or not, tool peons apart, and the routes", async () => {
    const out = await Effect.runPromise(toolsWith(fakeHost().host).peon_catalog({}));
    expect(out.text.split("\n").slice(0, 5)).toEqual([
      "🪓 3 catalog peons (2 runnable), 4 routes (table v3); outcome rates are unmeasured until outcome events land.",
      `- fix-review@1 · judge · sol high · runnable, digest ${catalog.think[0]?.digest.slice(0, 12)}`,
      `- fix-ask@2 · read · gpt-6-luna medium · runnable, digest ${catalog.think[1]?.digest.slice(0, 12)}`,
      "- fix-build@1 · work · sol high · not cell-ready",
      `- fix-tool@1 · tool peon, not in catalog.json · openai-codex/gpt-6.1-sol medium · digest ${"0".repeat(12)} · not run by peon_run`,
    ]);
  });
});
