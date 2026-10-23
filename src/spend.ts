// Spend policy as a pure decision over ledger facts. The ledger is append-only
// history; "calls used" is a projection of it, never stored.
import { Schema } from "effect";

import { ArrowRefusal } from "./template-node.ts";

export const LedgerFact = Schema.Union([
  Schema.Struct({ at: Schema.String, event: Schema.Literal("reserved"), model: Schema.String, requestId: Schema.String }),
  Schema.Struct({ at: Schema.String, event: Schema.Literal("settled"), listCostUsd: Schema.Number, requestId: Schema.String }),
  Schema.Struct({ at: Schema.String, event: Schema.Literal("refused"), refusal: ArrowRefusal, requestId: Schema.String }),
]);
export type LedgerFact = typeof LedgerFact.Type;

const decodeFact = Schema.decodeUnknownSync(Schema.fromJsonString(LedgerFact));

// A line that doesn't decode is a fault in the ledger, not a fact to skip.
export const parseLedger = (text: string): LedgerFact[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => decodeFact(line));

export type SpendDecision =
  | { readonly kind: "allowed"; readonly call: number; readonly cap: number }
  | { readonly kind: "exhausted"; readonly used: number; readonly cap: number };

// A reservation counts even if its call never settled: a crash must not refund a call.
export const decideSpend = (facts: readonly LedgerFact[], cap: number): SpendDecision => {
  const used = facts.filter((fact) => fact.event === "reserved").length;
  return used >= cap ? { cap, kind: "exhausted", used } : { call: used + 1, cap, kind: "allowed" };
};
