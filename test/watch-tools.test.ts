import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { HostFailure } from "../extensions/pi/host.ts";
import { liveWatchHost } from "../extensions/pi/live-host.ts";
import { WatchRefused } from "../extensions/pi/watch-contract.ts";
import type { ArmWatch, WatchHostPort, WatchStatus } from "../extensions/pi/watch-contract.ts";
import { makeWatchTools } from "../extensions/pi/watch-tools.ts";
import { convertUntilCondition, makeUntilReader } from "../extensions/pi/watch-until.ts";
import type { UntilContext } from "../extensions/pi/watch-until.ts";
import { bodyText, jsonResponse, urlText } from "./support.ts";

const owner = "did:web:peons.example";
const watchId = `watch-${"a".repeat(64)}`;
const desk = "peons/desk";
const localId = "b1234567";
const now = Date.parse("2026-01-01T00:00:00.000Z");
const curl = `[ "$(curl -s -o /dev/null -w '%{http_code}' https://status.example.com/health)" = 200 ]`;
const sha = "a".repeat(40);
const check = `shitrat checks owner/repo ${sha} | grep -q 'build / test.*completed'`;
const peon = `inspectPeon peon-a | jq -e '.state == "idle" and .pending == null'`;
const input: typeof ArmWatch.Type = {
  condition: { expect: { status: 200 }, type: "http", url: "https://status.example.com/health" },
  intervalSeconds: 60, kind: "once", label: "Site health", message: { body: "Check the app", summary: "Site is up" },
  notify: { cc: ["fleet/desk"], to: [desk] }, requestId: "check-site-1", timeoutSeconds: 240,
};
const watch = { armedAt: now, expiresAt: now + 240_000, kind: input.kind, label: input.label, notify: input.notify, owner, state: "armed" as const, watchId };
const inspection: typeof WatchStatus.Type = {
  cursor: "second-turn",
  evidence: [{ at: now, text: "HTTP 200" }],
  firings: [{ at: now, cursor: "second-turn", downgraded: [desk], messageId: "msg-x" }],
  lastCheck: { at: now, detail: "upstream timed out", outcome: "checkError" },
  watch: { ...watch, condition: input.condition, intervalSeconds: input.intervalSeconds, message: input.message, timeoutSeconds: input.timeoutSeconds },
};
const acknowledge = { state: "armed" as const, watchId };

const fixture = ({ arm = () => Effect.succeed(acknowledge), branch = [], clock = () => now, expire = true, settled = false, wake = "agent" }: {
  readonly arm?: WatchHostPort["arm"];
  readonly branch?: ReturnType<UntilContext["sessionManager"]["getBranch"]>;
  readonly clock?: () => number;
  readonly expire?: boolean;
  readonly settled?: boolean;
  readonly wake?: "agent" | "notify";
} = {}) => {
  const entries = [...branch];
  const receipt = { deliveries: 0, deliveryPending: false, ...(expire ? { expiresAt: "2026-01-01T00:04:00.000Z" } : {}), id: localId, intervalMs: 60_000, kind: wake === "notify" ? "until" : "recurring", label: "Old watch", status: "running", wake };
  let polls = 0;
  const executeTool = vi.fn<UntilContext["executeTool"]>().mockImplementation(async (_name, args) => {
    await Promise.resolve();
    if (args.action === "cancel") {return { details: { ...receipt, status: "cancelled" } };}
    polls += 1;
    return { details: { watches: settled && polls > 1 ? [{ ...receipt, status: "satisfied" }] : [receipt] } };
  });
  const host = {
    arm: vi.fn(arm),
    cancel: vi.fn<WatchHostPort["cancel"]>().mockReturnValue(Effect.succeed({ state: "cancelled" })),
    complete: vi.fn<WatchHostPort["complete"]>().mockReturnValue(Effect.succeed({ state: "done" })),
    inspect: vi.fn<WatchHostPort["inspect"]>().mockReturnValue(Effect.succeed(inspection)),
    list: vi.fn<WatchHostPort["list"]>().mockReturnValue(Effect.succeed({ watches: [watch] })),
  };
  const reader = makeUntilReader(clock);
  const until = reader.port({
    appendEntry: (customType, data) => {entries.push({ customType, data, type: "custom" });},
    executeTool,
    sessionManager: { getBranch: () => entries, getSessionId: () => "session-x" },
  });
  const observe = (condition: string, extra: Record<string, unknown> = {}) => {reader.observe({
    details: receipt, input: { action: wake === "notify" ? "start" : "repeat", condition, instruction: "Next step", quickRef: "Ready", ...extra }, toolName: "until",
  });};
  return { entries, executeTool, host, observe, tools: makeWatchTools({ desk: Effect.succeed(desk), host: Effect.succeed(host), until }) };
};

const move = { fromUntil: localId };

describe("pi-until conversion", () => {
  it("maps an explicit curl GET status comparison", () => {
    expect(convertUntilCondition(curl)).toEqual({ condition: input.condition });
  });
  it("selects the exact named check, not array order or the overall conclusion", () => {
    expect(convertUntilCondition(check)).toEqual({ condition: { expect: { equals: "completed", jsonPath: '$.check_runs[?(@.name=="build / test")].status', status: 200 }, type: "http", url: `https://api.github.com/repos/owner/repo/commits/${sha}/check-runs` } });
  });
  it("matches peon state and pending clear independently or together", () => {
    expect(convertUntilCondition(peon)).toEqual({ condition: { expect: { pendingClear: true, state: "idle" }, peonId: "peon-a", type: "peon" } });
    expect(convertUntilCondition(`peon_status peon-a | jq -e '.pending == null'`)).toEqual({ condition: { expect: { pendingClear: true }, peonId: "peon-a", type: "peon" } });
    expect(convertUntilCondition(`inspectPeon peon-a | jq -e '.state == "hibernated"'`)).toEqual({ condition: { expect: { state: "hibernated" }, peonId: "peon-a", type: "peon" } });
  });
  it.each([
    ["test -f /tmp/private-fixture", "local path"],
    ["herdr pane read worker | grep -q Ready", "local pane"],
    ["pgrep -x node", "local process"],
  ])("leaves %s local and never calls Mischief", async (condition, reason) => {
    const f = fixture();
    f.observe(condition);
    const out = await Effect.runPromise(f.tools.watch_arm(move));
    expect(out).toMatchObject({ data: { tag: "UntilNotMigrated" }, isError: true });
    expect(out.text).toContain(`${reason}; stays in pi-until`);
    expect(out.text).not.toContain(condition);
    expect(f.host.arm).not.toHaveBeenCalled();
    expect(f.executeTool.mock.calls).toEqual([["until", { action: "list" }]]);
  });
  it("does not translate status negation, extra shell or an unscoped completed match", () => {
    for (const condition of [curl.replace("= 200", "!= 200"), `${curl} || true`, `shitrat checks owner/repo ${sha} | grep -q 'completed'`, peon.replace(" and .pending == null", " and ")]) {
      expect(convertUntilCondition(condition)).toHaveProperty("reason");
    }
  });
});

describe("durable watch tools", () => {
  it("maps the recurring snapshot and cancels only after Mischief acknowledges arm", async () => {
    const f = fixture();
    f.observe(curl);
    const out = await Effect.runPromise(f.tools.watch_arm(move));
    const requestId = f.host.arm.mock.calls[0]?.[0].requestId;
    expect(requestId).toMatch(/^until-[a-f0-9]+$/u);
    expect(f.host.arm).toHaveBeenCalledWith({ ...input, kind: "repeat", label: "Old watch", message: { body: "Next step", summary: "Ready" }, notify: { cc: [], to: [desk] }, requestId });
    expect(out).toMatchObject({ data: { migration: "cancelled", watchId }, isError: false });
    expect(f.executeTool.mock.calls).toEqual([["until", { action: "list" }], ["until", { action: "list" }], ["until", { action: "cancel", id: localId }]]);
    expect(f.host.arm.mock.invocationCallOrder[0]).toBeLessThan(f.executeTool.mock.invocationCallOrder[2] ?? 0);
  });
  it("reads a restored suspension entry, uses cc for notify, and preserves the journal", async () => {
    const data = { sessionId: "session-x", v: 3, watches: [{ definition: { gate: { command: curl } }, facts: { id: localId } }] };
    const entry = { customType: "pi-until-suspended", data, type: "custom" };
    const f = fixture({ branch: [entry], wake: "notify" });
    expect(await Effect.runPromise(f.tools.watch_arm(move))).toMatchObject({ isError: false });
    expect(f.host.arm).toHaveBeenCalledWith(expect.objectContaining({ kind: "once", message: { body: "Old watch", summary: "Old watch" }, notify: { cc: [desk], to: [] } }));
    expect(f.entries[0]).toBe(entry);
    expect(f.entries[1]).toMatchObject({ customType: "peons-watch-arm-attempt", data: { timeoutSeconds: 240 } });
  });
  it("leaves the session watch running and renders the refusal when arming fails", async () => {
    const f = fixture({ arm: () => Effect.fail(new WatchRefused({ code: "HostNotAllowed", reason: "No allowed host" })) });
    f.observe(curl);
    const out = await Effect.runPromise(f.tools.watch_arm(move));
    expect(out).toMatchObject({ data: { code: "HostNotAllowed", tag: "WatchRefused" }, isError: true });
    expect(out.text.split("\n")).toEqual([expect.stringContaining("you called watch_arm, and it failed because HostNotAllowed: No allowed host"), expect.stringMatching(/^Accepted:/u), expect.stringContaining("Fix: use an approved HTTPS host, then call watch_arm again"), expect.stringMatching(/^Debug:/u)]);
    expect(f.executeTool.mock.calls).toEqual([["until", { action: "list" }]]);
  });
  it("reuses the complete arm payload after an unacknowledged request and time passes", async () => {
    let time = now;
    const arm = vi.fn<WatchHostPort["arm"]>().mockReturnValueOnce(Effect.fail(new HostFailure({ message: "lost ack" }))).mockReturnValue(Effect.succeed(acknowledge));
    const f = fixture({ arm, clock: () => time });
    f.observe(curl);
    expect(await Effect.runPromise(f.tools.watch_arm(move))).toMatchObject({ isError: true });
    expect(f.executeTool.mock.calls).toEqual([["until", { action: "list" }]]);
    time += 9000;
    expect(await Effect.runPromise(f.tools.watch_arm(move))).toMatchObject({ data: { migration: "cancelled" } });
    expect(arm.mock.calls[0]?.[0]).toEqual(arm.mock.calls[1]?.[0]);
  });
  it("does not cancel a session watch that settles while arm is in flight", async () => {
    const f = fixture({ settled: true });
    f.observe(curl);
    const result = await Effect.runPromise(f.tools.watch_arm(move));
    expect(result.data).toMatchObject({ migration: "settled", watchId });
    expect(f.executeTool.mock.calls).toEqual([["until", { action: "list" }], ["until", { action: "list" }]]);
  });
  it("lets the caller set a timeout for an indefinite watch without guessing one", async () => {
    const f = fixture({ expire: false });
    f.observe(curl);
    const out = await Effect.runPromise(f.tools.watch_arm(move));
    expect(out.text).toContain("has no expiry");
    expect(f.host.arm).not.toHaveBeenCalled();
    await Effect.runPromise(f.tools.watch_arm({ ...move, timeoutSeconds: 120 }));
    expect(f.host.arm).toHaveBeenCalledWith(expect.objectContaining({ timeoutSeconds: 120 }));
  });
  it("passes direct arm and mutation inputs through with no pi-until calls", async () => {
    const f = fixture();
    const mutation = { requestId: "stop-1", watchId };
    expect(await Effect.runPromise(f.tools.watch_arm(input))).toMatchObject({ data: acknowledge, isError: false });
    expect(await Effect.runPromise(f.tools.watch_cancel(mutation))).toMatchObject({ data: { state: "cancelled", watchId }, isError: false });
    expect(await Effect.runPromise(f.tools.watch_complete(mutation))).toMatchObject({ data: { state: "done", watchId }, isError: false });
    expect(f.host.arm).toHaveBeenCalledWith(input);
    expect(f.host.cancel).toHaveBeenCalledWith(mutation);
    expect(f.host.complete).toHaveBeenCalledWith(mutation);
    expect(f.executeTool).not.toHaveBeenCalled();
  });
  it("formats list and status, including failures and wake downgrades", async () => {
    const f = fixture();
    const filter = { owner, target: desk };
    const list = await Effect.runPromise(f.tools.watch_list(filter));
    expect(f.host.list).toHaveBeenCalledWith(filter);
    expect(list.text).toContain(`Durable watches (1):\n${watchId} · armed · once · Site health · owner ${owner} · to: ${desk} · cc: fleet/desk`);
    const status = await Effect.runPromise(f.tools.watch_status({ watchId }));
    expect(status.data).toEqual(inspection);
    for (const detail of ["Last check: checkError", "upstream timed out", "Cursor: second-turn", "Evidence (1):", "HTTP 200", "Firings (1):", `msg-x · cursor second-turn · downgraded to cc: ${desk}`]) {
      expect(status.text).toContain(detail);
    }
    f.host.list.mockReturnValue(Effect.succeed({ watches: [] }));
    f.host.inspect.mockReturnValue(Effect.succeed({ ...inspection, cursor: null, evidence: [], firings: [], lastCheck: null }));
    const emptyList = await Effect.runPromise(f.tools.watch_list({}));
    const emptyStatus = await Effect.runPromise(f.tools.watch_status({ watchId }));
    expect(emptyList.text).toBe("No durable watches match.");
    expect(emptyStatus.text).toContain("Last check: none yet\nCursor: —");
  });
});

describe("signed watch host", () => {
  it("uses all five capability paths and DID claims over a fake fetch, and decodes typed refusals", async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const calls: { body: string; path: string; payload: string }[] = [];
    const responses = new Map<string, unknown>([["armWatch", acknowledge], ["listWatches", { watches: [watch] }], ["inspectWatch", inspection], ["completeWatch", { state: "done" }]]);
    const host = liveWatchHost({
      audience: "fake-worker", endpoint: "https://mischief.example/",
      fetch: async (url, init) => {
        const path = new URL(urlText(url)).pathname.slice(1);
        const payload = new Headers(init?.headers).get("authorization")?.split(".")[1] ?? "";
        calls.push({ body: bodyText(init), path, payload: Buffer.from(payload, "base64url").toString() });
        return path === "cancelWatch" ? await jsonResponse({ _tag: "WatchRefused", code: "NotOwner", reason: "only the owner can stop it" }, 422) : await jsonResponse(responses.get(path));
      },
      signer: Effect.succeed({ did: owner, key: keys.privateKey }),
    });
    const mutation = { requestId: "stop-1", watchId };
    expect(await Effect.runPromise(host.arm(input))).toEqual(acknowledge);
    expect(await Effect.runPromise(host.list({ owner }))).toEqual({ watches: [watch] });
    expect(await Effect.runPromise(host.inspect({ watchId }))).toEqual(inspection);
    expect(await Effect.runPromise(host.complete(mutation))).toEqual({ state: "done" });
    expect(await Effect.runPromise(Effect.result(host.cancel(mutation)))).toMatchObject({ _tag: "Failure", failure: { _tag: "WatchRefused", code: "NotOwner" } });
    expect(calls.map(({ path }) => path)).toEqual(["armWatch", "listWatches", "inspectWatch", "completeWatch", "cancelWatch"]);
    for (const { path, payload } of calls) {
      expect(JSON.parse(payload)).toMatchObject({ aud: "fake-worker", iss: owner, lxm: `sh.mschf.mischief.${path}` });
    }
    expect(calls.map(({ body }): unknown => JSON.parse(body))).toEqual([input, { owner }, { watchId }, mutation, mutation]);
  });
});
