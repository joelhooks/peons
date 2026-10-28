// An observation model, not a second run host. Mischief owns execution and persistence.
// A blocked run can resume after an answer; even a failed observation can resume after
// extendRun (envelope-exceeded). Only done and a refused submission/identity end this
// attempt. Start a fresh model for a retry, just as submitOnce inspects the host again.
// Keep this separate from fromRunReport: that stateless projection accepts fresh reports,
// including older/out-of-order ones, and must not acquire sticky local terminal state.
import { setupEffect } from "@xstate/effect";
import { Schema } from "effect";

import { RunReport, decodeVerdict, frozenOf, verdictDocs } from "./run-report.ts";

const Addressed = Schema.Struct({ desk: Schema.String, runId: Schema.String });
const Inspect = Schema.Struct({ report: RunReport, request: Addressed });
type Inspect = typeof Inspect.Type;

const observed = ({ report, request }: Inspect) => {
  const frozen = frozenOf(report);
  if (frozen === null || frozen.runId !== request.runId || frozen.desk !== request.desk) {
    return { target: "refused" } as const;
  }
  const final = frozen.steps[frozen.final] ?? Object.values(frozen.steps)[0];
  if (final === undefined) {return { target: "refused" } as const;}
  if (report.status === "done") {
    const doc = report.docs[frozen.writes];
    if (report.value === "rejected" || doc === undefined || (final.verdict !== null && !decodeVerdict(final.verdict, doc, verdictDocs(final, report.docs)).ok)) {
      return { target: "failed" } as const;
    }
    return { target: "done" } as const;
  }
  if (report.status === "waiting-for-reply" && report.awaiting?.[0] !== undefined) {
    return { target: "blocked" } as const;
  }
  if (report.status === "waiting-for-joel" && report.question !== undefined) {
    return { target: "blocked" } as const;
  }
  if (["failed", "aborted", "amendment-refused", "envelope-exceeded", "stuck"].includes(report.status)) {
    return { target: "failed" } as const;
  }
  return { target: "running" } as const;
};

const on = {
  inspect: ({ event }: { readonly event: Inspect }) => observed(event),
  "submit-refused": { target: "refused" },
} as const;

export const runMachine = setupEffect({
  schemas: { events: { inspect: Inspect, "submit-refused": Schema.Struct({}) } },
}).createMachine({
  id: "peon-run",
  initial: "running",
  states: {
    blocked: { on },
    done: { type: "final" },
    failed: { on },
    refused: { type: "final" },
    running: { on },
  },
});
