// Payload cases exercise guarded edges, not just one shortest path per state. Each case
// traverses the real machine, then compares every generated step with the real mapper.
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { getShortestPaths } from "xstate/graph";

import { PeonRunResult } from "../src/contract.ts";
import { runMachine } from "../src/run-machine.ts";
import { fromRunReport, runStatuses } from "../src/run-report.ts";
import type { RunReport } from "../src/run-report.ts";
import { ask, inspect, profile, question, reportOf, request, stateOf, think } from "./run-model-support.ts";

const pending = new Set(["running", "paused", "waiting-for-provider", "waiting-for-joel", "waiting-for-reply"]);
const cases: { name: string; report: RunReport; state: string }[] = runStatuses.map((status) => {
  if (status === "done") {return { name: status, report: reportOf(status), state: "done" };}
  return { name: status, report: reportOf(status), state: pending.has(status) ? "running" : "failed" };
});
cases.push(
  { name: "reply with evidence", report: reportOf("waiting-for-reply", { awaiting: [ask] }), state: "blocked" },
  { name: "empty awaiting", report: reportOf("waiting-for-reply", { awaiting: [] }), state: "running" },
  { name: "judge with evidence", report: reportOf("waiting-for-joel", { question }), state: "blocked" },
  { name: "unrelated ask is not blocked", report: reportOf("paused", { awaiting: [ask], question }), state: "running" },
  { name: "rejected gate", report: reportOf("done", { value: "rejected" }), state: "failed" },
  { name: "missing artifact", report: reportOf("done", { docs: profile.docs }), state: "failed" },
  { name: "empty artifact is present", report: reportOf("done", { docs: { ...profile.docs, artifact: "" } }), state: "done" },
  { name: "invalid verdict JSON", report: reportOf("done", {}, think), state: "failed" },
  { name: "wrong verdict schema", report: reportOf("done", { docs: { ...think.docs, review: {} } }, think), state: "failed" },
  { name: "valid verdict", report: reportOf("done", { docs: { ...think.docs, review: { blockers: [], checked: [], findings: [], schema: "peons.verdict.change-review.v1", unverified: [], verdict: "approve" } } }, think), state: "done" },
  ...runStatuses.map((status) => ({ name: `no frozen identity: ${status}`, report: reportOf(status, { docs: {} }), state: "refused" })),
);

describe("run report observation model", () => {
  for (const sample of cases) {
    it(sample.name, () => {
      const event = inspect(sample.report);
      const paths = getShortestPaths(runMachine, { events: [event] });
      // Independent expectation means deleting a transition or weakening a guard
      // cannot silently reduce the paths and make the test pass vacuously.
      expect(paths.some((path) => path.state.value === sample.state)).toBe(true);
      for (const path of paths) {
        for (const step of path.steps) {
          if (step.event.type !== "inspect") {continue;}
          const actual = fromRunReport(step.event.report, step.event.request);
          expect(Schema.is(PeonRunResult)(actual)).toBe(true);
          expect(stateOf(actual)).toBe(step.state.value);
          expect(stateOf(actual)).toBe(sample.state);
        }
      }
    });
  }

  for (const wrong of [{ desk: "other/desk", runId: request.runId }, { ...request, runId: "other-run" }]) {
    it(`refuses a frozen identity that differs from ${JSON.stringify(wrong)}`, () => {
      const event = { report: reportOf("done"), request: wrong, type: "inspect" as const };
      const paths = getShortestPaths(runMachine, { events: [event] });
      expect(paths.map((path) => path.state.value)).toContain("refused");
      expect(fromRunReport(event.report, wrong)).toMatchObject({ tag: "FrozenRouteMissing", type: "peon.refused" });
    });
  }
});
