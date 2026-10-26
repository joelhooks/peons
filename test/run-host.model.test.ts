// The model drives the real submit/inspect seam. The fake host is the existing
// in-memory port, not another lifecycle implementation.
import { Effect } from "effect";
import { forEach } from "effect/Effect";
import { describe, expect, it } from "vitest";
import { initialTransition, transition } from "xstate";
import { getShortestPaths, getSimplePaths } from "xstate/graph";

import { runMachine } from "../src/run-machine.ts";
import { fromRunReport } from "../src/run-report.ts";
import { PlanRefused } from "../extensions/pi/host.ts";
import { submitOnce } from "../extensions/pi/tools.ts";
import { ask, inspect, profile, question, reportOf, request, stateOf } from "./run-model-support.ts";
import { fakeHost } from "./support.ts";

const events = [
  inspect(reportOf("waiting-for-reply", { awaiting: [ask] })),
  inspect(reportOf("failed", { failures: [{ key: "work", reason: "stream closed" }] })),
  inspect(reportOf("done")),
];
const submit = async (host: ReturnType<typeof fakeHost>["host"]) =>
  await Effect.runPromise(submitOnce(host, profile, request, "unknown", null));

describe("host lifecycle paths", () => {
  const paths = getSimplePaths(runMachine, { events });
  it("generates paths through every observable state", () => {
    expect(new Set(paths.map((path) => path.state.value))).toEqual(new Set(["running", "blocked", "failed", "done"]));
    expect(paths.some((path) => path.steps.length >= 3)).toBe(true);
  });

  for (const [index, path] of paths.entries()) {
    it(`replays generated host path ${index}: ${path.state.value}`, async () => {
      const fake = fakeHost();
      expect(stateOf(await submit(fake.host))).toBe("running");
      await Effect.runPromise(forEach(path.steps, (step) => Effect.gen(function* replay() {
        if (step.event.type !== "inspect") {return;}
        fake.patch(profile.runId, step.event.report);
        const actual = yield* submitOnce(fake.host, profile, request, "unknown", null);
        expect(stateOf(actual)).toBe(step.state.value);
      })));
      expect(fake.calls.submit).toHaveLength(1);
      expect(fake.calls.charges).toHaveLength(1);
    });
  }

  for (const mode of ["reply", "judge", "envelope"] as const) {
    it(`resumes ${mode} using generated paths, without a second submission`, async () => {
      const reports = { envelope: reportOf("envelope-exceeded"), judge: reportOf("waiting-for-joel", { question }), reply: reportOf("waiting-for-reply", { awaiting: [ask] }) };
      const first = reports[mode];
      const [initial] = initialTransition(runMachine);
      const [fromState] = transition(runMachine, initial, inspect(first));
      const resumePaths = getShortestPaths(runMachine, { events: [inspect(reportOf("running"))], fromState });
      const resumed = resumePaths.find((path) => path.state.value === "running");
      expect(resumed).toBeDefined();
      const fake = fakeHost();
      await submit(fake.host);
      fake.patch(profile.runId, first);
      expect(stateOf(await submit(fake.host))).toBe(fromState.value);
      if (mode === "reply") {
        await Effect.runPromise(fake.host.deliver({ body: "the left one", replyTo: ask.messageId, runId: profile.runId }));
      } else if (mode === "judge") {
        await Effect.runPromise(fake.host.answer(profile.runId, "pass"));
      } else {
        // extendRun belongs to Mischief, not RunHostPort; observe its fresh report.
        fake.patch(profile.runId, reportOf("running"));
      }
      await Effect.runPromise(forEach(resumed?.steps ?? [], (step) => Effect.gen(function* resumedStep() {
        if (step.event.type !== "inspect") {return;}
        const actual = yield* submitOnce(fake.host, profile, request, "unknown", null);
        expect(stateOf(actual)).toBe(step.state.value);
      })));
      expect(fake.calls.submit).toHaveLength(1);
      expect(fake.calls.charges).toHaveLength(1);
    });
  }

  it("keeps a finished attempt terminal; a retry starts from a fresh host inspection", async () => {
    const terminalPaths = getShortestPaths(runMachine, { events: [...events, { type: "submit-refused" }] }).filter((path) => path.state.status === "done");
    expect(new Set(terminalPaths.map((path) => path.state.value))).toEqual(new Set(["done", "refused"]));
    for (const path of terminalPaths) {
      for (const event of [...events, inspect(reportOf("running")), { type: "submit-refused" as const }]) {
        const [next, effects] = transition(runMachine, path.state, event);
        expect(next).toBe(path.state);
        expect(effects).toEqual([]);
      }
    }
    const fake = fakeHost();
    // No sticky actor/cache in submitOnce: another call checks the host afresh.
    expect(stateOf(await submit(fake.host))).toBe("running");
    expect(fake.calls.inspect).toEqual([profile.runId]);
    expect(fake.calls.charges).toHaveLength(1);
  });

  it("models a real submission refusal without charging or storing a run", async () => {
    const refusalPaths = getShortestPaths(runMachine, { events: [{ type: "submit-refused" }, inspect(reportOf("running"))] });
    expect(refusalPaths.map((path) => path.state.value)).toContain("refused");
    const fake = fakeHost();
    const host = { ...fake.host, submit: () => Effect.fail(new PlanRefused({ errors: ["outside envelope"] })) };
    await Effect.runPromise(forEach(refusalPaths.flatMap((path) => path.steps), (step) => Effect.gen(function* refusedStep() {
      if (step.event.type !== "submit-refused") {return;}
      const actual = yield* submitOnce(host, profile, request, "unknown", null);
      expect(stateOf(actual)).toBe(step.state.value);
      expect(fromRunReport({ errors: ["outside envelope"], kind: "submit-refused", route: null, template: "unknown" }, request)).toMatchObject({ tag: "PlanRefused", type: "peon.refused" });
    })));
    expect(fake.runs.size).toBe(0);
    expect(fake.calls.charges).toHaveLength(0);
  });
});
