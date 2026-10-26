import { Schema } from "effect";
import type { EventFromLogic } from "xstate";

import { PeonRequest } from "../src/contract.ts";
import { Prompt, compileRun } from "../src/compile.ts";
import { RouteRefused, resolveRoute } from "../src/routing.ts";
import type { runMachine } from "../src/run-machine.ts";
import type { PeonRunResult, RunReport } from "../src/run-report.ts";
import { DESK, reviewTemplate, routing } from "./support.ts";

export const request = { desk: DESK, runId: "model-run" };
export const compiled = (concept: "scan" | "review") => {
  const route = resolveRoute(routing, concept);
  if (route instanceof RouteRefused) {throw route;}
  const input = Schema.decodeSync(PeonRequest)({ ...request, base: null, input: { docs: { subject: "a fence" }, kind: "brief", text: "Review the fence." }, schema: "peons.request.v1", scope: [], target: { kind: "work-type", workType: concept } });
  const result = compileRun(input, route, concept === "review" ? reviewTemplate : null);
  if (result instanceof Prompt) {throw new TypeError(result.message);}
  return result;
};
export const profile = compiled("scan");
export const think = compiled("review");
export const reportOf = (status: RunReport["status"], change: Partial<RunReport> = {}, source = profile): RunReport => ({
  docs: { ...source.docs, [source.frozen.writes]: "artifact" },
  planId: source.plan.id,
  planVersion: 1,
  runId: source.runId,
  status,
  transitions: 1,
  value: source.frozen.final,
  ...change,
});
export type RunEvent = EventFromLogic<typeof runMachine>;
export const inspect = (report: RunReport): RunEvent => ({ report, request, type: "inspect" });
export const stateOf = (result: PeonRunResult) => "type" in result ? result.type.slice("peon.".length) : result.status;
export const ask = { key: "work", message: "Which fence?", messageId: "ask-1", to: DESK, writes: null };
export const question = { answered: 0, key: "work", options: ["pass", "fail"], question: "Does it pass?" };
