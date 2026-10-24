import { Effect, Exit, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { describe, expect, it } from "vitest";

import { MischiefSubmission, canonical, parseJson } from "../src/compile.ts";
import { fromRunReport } from "../src/run-report.ts";
import type { RunHostPort } from "../extensions/pi/host.ts";
import type { ToolOutput } from "../extensions/pi/tools.ts";
import { liveEnv } from "../extensions/pi/live-host.ts";
import { makeTools } from "../extensions/pi/tools.ts";
import { PlanRefused } from "../extensions/pi/host.ts";
import { DESK, bool, catalog, fakeHost, forAll, int, memoryFiles, mischiefRunId, pick, run, toolsWith } from "./support.ts";

// A desk process: a fresh tools instance, as after a crash and restart.
type PeonRun = (raw: unknown) => Effect.Effect<ToolOutput>;
type Process = (host: RunHostPort, attempt: number) => PeonRun;

const realProcess: Process = (host) => toolsWith(host).peon_run;

const crashPoints = ["none", "before-submit", "after-submit", "after-record"] as const;
type Crash = (typeof crashPoints)[number];

const crashing = (host: RunHostPort, crash: Crash): RunHostPort => {
  if (crash === "before-submit") {return { ...host, submit: () => Effect.die("crash before submit") };}
  if (crash === "after-submit") {return { ...host, submit: (runId, plan, docs) => host.submit(runId, plan, docs).pipe(Effect.andThen(Effect.die("crash after submit"))) };}
  return host;
};

const Schedule = Arbitrary.array(Arbitrary.all({ crash: pick(...crashPoints), request: int(0, 3) }), { maxLength: 8, minLength: 1 });
interface Step { readonly request: number; readonly crash: Crash }

// Requests 0 and 2 are {profile} routes; 1 and 3 are {peon} routes through think-template.ts.
const params = (index: number) =>
  [
    { brief: `Request ${index}.`, runId: `req-${index}`, workType: "scan" },
    { brief: `Request ${index}.`, docs: { subject: "diff --git a/x b/x\n+fence" }, runId: `req-${index}`, workType: "review" },
    { brief: `Request ${index}.`, runId: `req-${index}`, workType: "docs" },
    { brief: `Request ${index}.`, docs: { evidence: "Tests 47 passed | 2 skipped (49)" }, peon: "fix-ask@2", runId: `req-${index}` },
  ][index] ?? { brief: "x", runId: `req-${index}`, workType: "work" };

// Run, crash and resubmit: each step is one desk process calling peon_run; a crash kills it at the
// generated point, and the next process resubmits the same request.
const runSchedule = (process: Process, schedule: readonly Step[]) =>
  Effect.gen(function* runScheduleGen() {
    const fake = fakeHost();
    const outputs = new Map<number, ToolOutput>();
    let attempt = 0;
    for (const step of schedule) {
      attempt += 1;
      const exit = yield* Effect.exit(process(crashing(fake.host, step.crash), attempt)(params(step.request)));
      if (step.crash === "none" || step.crash === "after-record") {
        if (Exit.isFailure(exit)) {return false;}
        outputs.set(step.request, exit.value);
      }
      if (step.crash !== "none") {
        attempt += 1;
        const resubmit = yield* Effect.exit(process(fake.host, attempt)(params(step.request)));
        if (Exit.isFailure(resubmit)) {return false;}
        const stored = fake.runs.get(mischiefRunId(DESK, `req-${step.request}`));
        if (stored === undefined) {return false;}
        const expected = fromRunReport(stored.report, { desk: DESK, runId: `req-${step.request}` });
        const {data} = resubmit.value;
        if (typeof data !== "object" || data === null || !("result" in data) || canonical(data.result) !== canonical(expected)) {return false;}
      }
    }
    const requests = new Set(schedule.map(({ request }) => request));
    const ids = [...requests].map((index) => mischiefRunId(DESK, `req-${index}`));
    const once = (calls: readonly string[]) => ids.every((id) => calls.filter((call) => call === id).length === 1);
    return once(fake.calls.charges) && once(fake.calls.submit) && fake.calls.charges.length === requests.size;
  });

const exactlyOnce = async (process: Process) => await forAll(Schedule, async (schedule: readonly Step[]) => await Effect.runPromise(runSchedule(process, schedule)));

const noLookup: Process = (host) => toolsWith({ ...host, inspect: (runId) => host.inspect(`missing-${runId}`) }).peon_run;

const local: Process = (host) => {
  const seen = new Map<string, ToolOutput>();
  const tools = toolsWith({ ...host, inspect: (runId) => host.inspect(`missing-${runId}`) });
  return (raw) => {
    const key = canonical(raw);
    const hit = seen.get(key);
    return hit === undefined
      ? tools.peon_run(raw).pipe(
          Effect.tap((out) =>
            Effect.sync(() => {
              seen.set(key, out);
            }),
          ),
        )
      : Effect.succeed(hit);
  };
};

const renaming: Process = (host, attempt) => (raw) => {
  const tools = toolsWith(host);
  return typeof raw === "object" && raw !== null && "runId" in raw && attempt > 1 ? tools.peon_run({ ...raw, runId: `${String(raw.runId)}-r${attempt}` }) : tools.peon_run(raw);
};

describe("peon_run idempotency on runId", () => {
  it("gives exactly one submit and one charge per runId over generated run, crash and resubmit schedules, and a resubmit returns the stored report", async () => {
    expect(await exactlyOnce(realProcess)).toBeUndefined();
  });

  it("plant: no host lookup before submit fails the property", async () => {
    expect(await exactlyOnce(noLookup)).toBeDefined();
  });

  it("plant: a local in-memory dedupe instead of the host lookup fails across a crash", async () => {
    expect(await exactlyOnce(local)).toBeDefined();
  });

  it("plant: a resubmit with a new runId on retry fails the property", async () => {
    expect(await exactlyOnce(renaming)).toBeDefined();
  });

  it("the fake host refuses a different plan body under the same runId, naming reviseRun", async () => {
    const fake = fakeHost();
    await run(toolsWith(fake.host).peon_run(params(0)));
    const id = mischiefRunId(DESK, "req-0");
    const stored = fake.runs.get(id);
    if (stored === undefined) {throw new Error("no run");}
    const plan = Schema.decodeUnknownSync(MischiefSubmission)(parseJson(stored.body));
    const exit = await Effect.runPromiseExit(fake.host.submit(id, { ...plan, goal: "different" }, {}));
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("reviseRun");
  });
});

// A run in some state, then an answer to some message id: an ask's reply goes to deliver, an
// escalation's choice to answer, and nothing goes anywhere unless the run awaits exactly that id.
const AnswerCase = Arbitrary.all({ answer: pick("m", "other", "stray", "escalation"), choice: pick("pass", "maybe"), state: pick("awaiting-m", "awaiting-other", "escalated", "running", "done") });

const answerTool = (host: RunHostPort) => toolsWith(host).peon_answer;
const awaitedBy = { "awaiting-m": "m", "awaiting-other": "other", done: null, escalated: "escalation", running: null } as const;
const messageFor = (id: string, name: string) => (name === "escalation" ? "announce:peon_judge#1" : `${id}/peon#${name}`);

const patchState = (fake: ReturnType<typeof fakeHost>, id: string, state: keyof typeof awaitedBy) => {
  if (state === "awaiting-m" || state === "awaiting-other") {fake.patch(id, { awaiting: [{ key: "peon", messageId: messageFor(id, awaitedBy[state]), to: DESK, writes: null }], status: "waiting-for-reply" });}
  if (state === "escalated") {fake.patch(id, { question: { answered: 0, key: "peon_judge", options: ["pass", "fail"], question: "Pass?" }, status: "waiting-for-joel" });}
  if (state === "done") {fake.patch(id, { status: "done" });}
};

const deliversOnlyWhileAwaiting = async (answer: (host: RunHostPort) => (raw: unknown) => Effect.Effect<ToolOutput>) =>
  await forAll(AnswerCase, async (c) => {
    const fake = fakeHost();
    await run(toolsWith(fake.host).peon_run(params(1)));
    const id = mischiefRunId(DESK, "req-1");
    const message = (name: string) => messageFor(id, name);
    patchState(fake, id, c.state);
    const awaited = awaitedBy[c.state];
    const body = c.answer === "escalation" ? c.choice : "approve";
    const out = await run(answer(fake.host)({ answer: body, messageId: message(c.answer), runId: "req-1" }));
    const sent = fake.calls.deliver.length + fake.calls.answer.length;
    if (awaited !== c.answer || (c.answer === "escalation" && c.choice !== "pass")) {return sent === 0 && out.isError && out.text.startsWith("AnswerRefused:");}
    return c.answer === "escalation"
      ? fake.calls.answer.length === 1 && fake.calls.answer[0]?.reply === "pass" && fake.calls.deliver.length === 0 && !out.isError
      : fake.calls.deliver.length === 1 && fake.calls.deliver[0]?.replyTo === message(c.answer) && fake.calls.answer.length === 0 && !out.isError;
  });

const unchecked = (host: RunHostPort) => (raw: unknown) =>
  Effect.gen(function* uncheckedGen() {
    const given = typeof raw === "object" && raw !== null && "messageId" in raw && "runId" in raw ? raw : { messageId: "", runId: "" };
    yield* host.deliver({ body: "approve", replyTo: String(given.messageId), runId: mischiefRunId(DESK, String(given.runId)) }).pipe(Effect.ignore);
    return { data: null, isError: false, text: "delivered" } satisfies ToolOutput;
  });

describe("peon_answer", () => {
  it("round-trips a blocked record to deliver, and delivers only while the run awaits that messageId", async () => {
    const fake = fakeHost();
    const tools = toolsWith(fake.host);
    await run(tools.peon_run(params(2)));
    const id = mischiefRunId(DESK, "req-2");
    fake.patch(id, { awaiting: [{ key: "work", message: "Which gate first?", messageId: `${id}/work#1`, to: DESK, writes: null }], status: "waiting-for-reply" });
    const status = await run(tools.peon_status({ runId: "req-2" }));
    const blocked = typeof status.data === "object" && status.data !== null && "result" in status.data ? status.data.result : null;
    expect(blocked).toMatchObject({ choices: [], messageId: `${id}/work#1`, question: "Which gate first?", type: "peon.blocked" });
    const answered = await run(tools.peon_answer({ answer: "yes", messageId: `${id}/work#1`, runId: "req-2" }));
    expect(fake.calls.deliver).toEqual([{ body: "yes", replyTo: `${id}/work#1`, runId: id }]);
    expect(answered.data).toMatchObject({ result: { status: "running" } });
    expect(await deliversOnlyWhileAwaiting(answerTool)).toBeUndefined();
  });

  it("plant: answering while not awaiting fails the property", async () => {
    expect(await deliversOnlyWhileAwaiting(unchecked)).toBeDefined();
  });
});

describe("peon tools", () => {
  it("refuses a run with a 4-line prompt when MISCHIEF_HOST or the identity secret name is missing", async () => {
    const env = liveEnv({}, "peon_run");
    if (!("tag" in env)) {throw new Error("expected a refusal");}
    const tools = makeTools({ catalog, cwd: "/work", desk: Effect.succeed(DESK), files: memoryFiles().files, host: Effect.fail(env) });
    const out = await run(tools.peon_run(params(0)));
    expect(out.isError).toBe(true);
    expect(out.text.split("\n").map((line) => line.split(":")[0])).toEqual(["HostUnset", "Accepted", "Fix", "Debug"]);
    expect(out.text).toContain("MISCHIEF_HOST and PEONS_IDENTITY_SECRET");
  });

  it("returns a refused record for an unknown work type or template, naming the accepted ones", async () => {
    const fake = fakeHost();
    const tools = toolsWith(fake.host);
    const route = await run(tools.peon_run({ brief: "b", runId: "x", workType: "nonsense" }));
    expect(route.isError).toBe(true);
    expect(route.data).toMatchObject({ result: { tag: "RouteRefused", type: "peon.refused" } });
    expect(route.text).toContain("scan");
    const templates = await Promise.all(["nope@1", "fix-tool@1", "fix-build@1"].map(async (peon) => await run(tools.peon_run({ brief: "b", peon, runId: "y" }))));
    for (const template of templates) {
      expect(template.text.split("\n")[1]).toBe("Accepted: fix-ask@2, fix-review@1");
    }
    const input = await run(tools.peon_run({ brief: "b", peon: "fix-ask", runId: "z" }));
    expect(input.data).toMatchObject({ result: { tag: "MissingInput", template: "fix-ask", type: "peon.refused" } });
    expect(fake.calls.submit).toEqual([]);
  });

  it("maps a submit 422 to peon.refused PlanRefused with Mischief's errors, and charges nothing", async () => {
    const fake = fakeHost();
    const tools = toolsWith({ ...fake.host, submit: () => Effect.fail(new PlanRefused({ errors: ['peon: model "sol" is outside the envelope'] })) });
    const out = await run(tools.peon_run(params(1)));
    expect(out.isError).toBe(true);
    expect(out.text.split("\n").map((line) => line.split(":")[0])).toEqual(["PlanRefused", "Accepted", "Fix", "Debug"]);
    expect(out.text).toContain("outside the envelope");
    expect(fake.calls.charges).toEqual([]);
  });

  it("refuses bad arguments by path, never echoing the values", async () => {
    const out = await run(toolsWith(fakeHost().host).peon_run({ base: { repo: 7 }, brief: "secret customer note", workType: "scan" }));
    expect(out.text.split("\n")[0]).toMatch(/^ParamsRefused: /u);
    expect(out.text).not.toContain("secret customer note");
  });

  it("verifies a done run's artifact doc against a claimed sha256", async () => {
    const fake = fakeHost();
    const tools = toolsWith(fake.host);
    await run(tools.peon_run(params(2)));
    const id = mischiefRunId(DESK, "req-2");
    const stored = fake.runs.get(id);
    fake.patch(id, { docs: { ...stored?.report.docs, artifact: "hello" }, status: "done" });
    const done = await run(tools.peon_status({ runId: "req-2" }));
    const sha = typeof done.data === "object" && done.data !== null && "result" in done.data && typeof done.data.result === "object" && done.data.result !== null && "artifact" in done.data.result ? done.data.result.artifact : null;
    expect(sha).toMatchObject({ bytes: 5, name: "artifact" });
    const claimed = typeof sha === "object" && sha !== null && "sha256" in sha ? String(sha.sha256) : "";
    const matching = await run(tools.peon_verify({ runId: "req-2", sha256: claimed }));
    expect(matching.text).toMatch(/^✅ doc-sha256:artifact/u);
    const mismatching = await run(tools.peon_verify({ runId: "req-2", sha256: "0".repeat(64) }));
    expect(mismatching.isError).toBe(true);
  });
});

// A think verdict whose quotes are generated, each kept exact or altered by one character.
const verdictWith = (quotes: readonly { readonly source: string; readonly quote: string }[]) =>
  JSON.stringify({ answer: "two skipped", confidence: "high", findings: quotes.map((evidence) => ({ claim: "c", evidence: [evidence], measured: true })), ruledOut: [], schema: "peons.verdict.investigation.v1", unmeasured: [] });

const Quotes = Arbitrary.array(Arbitrary.all({ altered: bool, length: int(1, 10), source: pick("evidence", "brief", "rules"), start: int(0, 20) }), { maxLength: 5, minLength: 1 });

const verifyCatches = async (verify: (tools: ReturnType<typeof toolsWith>, raw: unknown) => Effect.Effect<ToolOutput>) =>
  await forAll(Quotes, async (generated) => {
    const fake = fakeHost();
    const tools = toolsWith(fake.host);
    await run(tools.peon_run(params(3)));
    const id = mischiefRunId(DESK, "req-3");
    const docs = fake.runs.get(id)?.report.docs ?? {};
    const text = (source: string) => { const doc = docs[source]; return typeof doc === "string" ? doc : ""; };
    const quotes = generated.map(({ start, length, source, altered }) => {
      const exact = text(source).slice(start, start + length) || text(source).slice(0, 1);
      return { quote: altered ? `${exact}\u2063` : exact, source };
    });
    fake.patch(id, { docs: { ...docs, answer: verdictWith(quotes) }, status: "done" });
    const out = await run(verify(tools, { runId: "req-3" }));
    const anyAltered = generated.some(({ altered }) => altered);
    // Source names may appear; quote text may not.
    const shown = out.text.replaceAll(/\b(?:evidence|brief|rules|answer)\b/gu, "");
    return out.isError === anyAltered && out.text.includes(anyAltered ? "❌ verdict-quotes:answer" : "✅ verdict-quotes:answer") && !quotes.some(({ quote }) => quote.length > 3 && shown.includes(quote));
  }, 100);

const shaOnly = (tools: ReturnType<typeof toolsWith>, raw: unknown) => tools.peon_verify(raw).pipe(Effect.map((out) => ({ ...out, isError: out.text.split("\n")[0]?.startsWith("❌") ?? false, text: out.text.replace("❌ verdict-quotes", "✅ verdict-quotes") })));

describe("peon_verify on think verdicts", () => {
  it("passes exactly when every quote is an exact substring of the doc it cites, and never echoes a quote", async () => {
    expect(await verifyCatches((tools, raw) => tools.peon_verify(raw))).toBeUndefined();
  });

  it("plant: a verdict with one altered quote must fail peon_verify; checking only the sha256 misses it", async () => {
    expect(await verifyCatches(shaOnly)).toBeDefined();
  });
});
