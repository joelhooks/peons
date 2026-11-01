// Generated Arrow call histories against a reference model of the spend ledger. The driver repeats
// bin/arrow.ts's order (read and parse the JSONL ledger, decide, append reserved, call, append
// settled or refused) over an in-memory ledger text, using the real decideSpend, parseLedger,
// priceUsd and artifact builders. The model counts calls and list cost on its own.
import { Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { describe, expect, it } from "vitest";

import { made, refused } from "../src/artifact.ts";
import type { ArrowArtifact } from "../src/artifact.ts";
import { priceUsd } from "../src/quiver.ts";
import { decideSpend, parseLedger } from "../src/spend.ts";
import type { LedgerFact } from "../src/spend.ts";
import { firstOf, replay, same } from "./command-model.ts";
import { forAll } from "./support.ts";

const models = ["arrow-2", "arrow-2-telos"] as const;
// Per million tokens; a cached input token costs a tenth of an uncached one.
const rates = { "arrow-2": { input: 4, output: 20 }, "arrow-2-telos": { input: 6, output: 30 } } as const;
type Outcome = "made" | "crash" | "provider-error" | "not-svg";
type Command =
  | { readonly op: "call"; readonly model: (typeof models)[number]; readonly outcome: Outcome; readonly input: number; readonly cached: number; readonly output: number }
  // The operator changes PEON_QUIVER_CALL_CAP between calls.
  | { readonly op: "cap"; readonly cap: number }
  // A crash mid-append leaves half a line; the next append lands on the same line.
  | { readonly op: "torn" };

const between = (minimum: number, maximum: number) => Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum, minimum })));
const outcomes: readonly Outcome[] = ["made", "made", "made", "crash", "provider-error", "not-svg"];
const CommandArb = Arbitrary.map(Arbitrary.all({ cached: between(0, 4000), cap: between(0, 6), input: between(0, 4000), kind: between(0, 19), model: between(0, 1), outcome: between(0, outcomes.length - 1), output: between(0, 2000) }), ({ cached, cap, input, kind, model, outcome, output }): Command => {
  if (kind === 0) {return { op: "torn" };}
  if (kind < 4) {return { cap, op: "cap" };}
  return { cached, input, model: models[model] ?? "arrow-2", op: "call", outcome: outcomes[outcome] ?? "made", output };
});
const Case = Arbitrary.all({ cap: between(0, 6), commands: Arbitrary.array(CommandArb, { maxLength: 30, minLength: 1 }) });
interface Case { readonly cap: number; readonly commands: readonly Command[] }

const digest = "0".repeat(64);
type Called = { readonly kind: "artifact"; readonly artifact: ArrowArtifact; readonly call: number | null } | { readonly kind: "crashed"; readonly call: number } | { readonly kind: "threw" };

// What a generated history reached, so a narrowed generator cannot pass vacuously.
const seen = new Set<string>();

const holds = async ({ cap: initialCap, commands }: Case, report?: (why: string) => void) => {
  let ledger = "";
  let cap = initialCap;
  const append = (fact: Omit<LedgerFact, "at"> & Record<string, unknown>) => {
    ledger += `${JSON.stringify({ at: "t", ...fact })}\n`;
  };
  // The arrow.ts sequence, one call per command, with the provider's answer given by the command.
  const arrow = (requestId: string, command: Extract<Command, { op: "call" }>): Called => {
    let facts: LedgerFact[];
    try {
      facts = parseLedger(ledger);
    } catch {
      return { kind: "threw" };
    }
    const spend = decideSpend(facts, cap);
    if (spend.kind === "exhausted") {
      append({ event: "refused", refusal: "envelope-exhausted", requestId });
      return { artifact: refused(requestId, digest, "envelope-exhausted", command.model), call: null, kind: "artifact" };
    }
    append({ call: spend.call, cap: spend.cap, event: "reserved", model: command.model, requestId });
    if (command.outcome === "crash") {return { call: spend.call, kind: "crashed" };}
    if (command.outcome !== "made") {
      append({ event: "refused", refusal: command.outcome, requestId });
      return { artifact: refused(requestId, digest, command.outcome, command.model), call: spend.call, kind: "artifact" };
    }
    const usage = { cacheRead: Math.min(command.cached, command.input), input: command.input, output: command.output };
    const artifact = made({ generationId: `g-${requestId}`, model: command.model, requestId, svgPath: `/out/${requestId}.svg`, svgSha256: digest, templateDigest: digest }, usage, priceUsd(command.model, usage));
    append({ event: "settled", listCostUsd: artifact.listCostUsd, requestId });
    return { artifact, call: spend.call, kind: "artifact" };
  };

  // Model: reservations ever made, settled list cost in order, refusals, and a torn tail.
  const model = { costs: [] as number[], refusals: 0, reserved: 0, torn: false };
  const step = (command: Command, index: number): string | undefined => {
    if (command.op === "cap") {({ cap } = command); return undefined;}
    if (command.op === "torn") {
      // Only the first half of a reservation reaches disk, without its newline.
      const line = JSON.stringify({ at: "t", call: 0, cap, event: "reserved", model: "arrow-2", requestId: `torn-${index}` });
      ledger += line.slice(0, Math.floor(line.length / 2));
      model.torn = true;
      return undefined;
    }
    const called = arrow(`r${index}`, command);
    if (model.torn) {
      seen.add("refused to guess a torn ledger");
      return same("a torn ledger stops spending", called.kind, "threw");
    }
    if (model.reserved >= cap) {
      seen.add(model.reserved > 0 ? "exhausted after spending" : "exhausted at cap 0");
      model.refusals += 1;
      return called.kind === "artifact" && called.artifact.outcome.kind === "refused"
        ? firstOf(same("exhausted refusal", called.artifact.outcome.refusal, "envelope-exhausted"), same("exhausted reserves nothing", called.call, null), same("exhausted costs nothing", called.artifact.listCostUsd, 0))
        : `expected an envelope-exhausted refusal, got ${called.kind}`;
    }
    model.reserved += 1;
    const call = model.reserved;
    if (called.kind === "threw") {return "threw on a whole ledger";}
    if (command.outcome === "crash") {
      seen.add("crash keeps its reservation");
      return same("crashed call number", called, { call, kind: "crashed" });
    }
    if (called.kind !== "artifact") {return `expected an artifact, got ${called.kind}`;}
    if (command.outcome !== "made") {
      model.refusals += 1;
      seen.add("provider refusal keeps its reservation");
      return firstOf(same("call number", called.call, call), same("provider refusal", called.artifact.outcome.kind === "refused" ? called.artifact.outcome.refusal : "made", command.outcome));
    }
    const rate = rates[command.model];
    const cacheRead = Math.min(command.cached, command.input);
    const cost = Number((((command.input - cacheRead) * rate.input + cacheRead * rate.input * 0.1 + command.output * rate.output) / 1_000_000).toFixed(4));
    model.costs.push(cost);
    seen.add(call === cap ? "made the last call under the cap" : "made a call under the cap");
    return firstOf(same("call number", called.call, call), call <= cap ? undefined : `call ${call} exceeds cap ${cap}`, same("made", called.artifact.outcome.kind, "made"), same("list cost", called.artifact.listCostUsd, cost));
  };

  // After every step the ledger itself agrees with the model, unless its tail is torn.
  const ledgerAgrees = (): string | undefined => {
    if (model.torn) {
      try {
        parseLedger(ledger);
        return "a torn ledger parsed";
      } catch {
        return undefined;
      }
    }
    const facts = parseLedger(ledger);
    const settled = facts.flatMap((fact) => (fact.event === "settled" ? [fact.listCostUsd] : []));
    const decision = decideSpend(facts, cap);
    return firstOf(
      same("reservations", facts.filter(({ event }) => event === "reserved").length, model.reserved),
      same("refusals", facts.filter(({ event }) => event === "refused").length, model.refusals),
      same("settled costs", settled, model.costs),
      settled.some((cost) => !(cost >= 0)) ? "a settled cost is negative or not a number" : undefined,
      same("next decision", decision, model.reserved >= cap ? { cap, kind: "exhausted", used: model.reserved } : { call: model.reserved + 1, cap, kind: "allowed" }),
    );
  };

  return await replay(commands, (command, index) => firstOf(step(command, index), ledgerAgrees()), report);
};

const call = (outcome: Outcome): Command => ({ cached: 100, input: 1000, model: "arrow-2", op: "call", outcome, output: 50 });

describe("spend ledger command model", () => {
  it("generated call/cap/torn histories match the reservation and cost model after every step", async () => {
    let why = "";
    const failure = await forAll(Case, async (value) => await holds(value, (mismatch) => { why = mismatch; }), 300, 30);
    expect(failure === undefined ? undefined : `${failure}\n${why}`).toBeUndefined();
    expect([...seen].toSorted()).toEqual(["crash keeps its reservation", "exhausted after spending", "exhausted at cap 0", "made a call under the cap", "made the last call under the cap", "provider refusal keeps its reservation", "refused to guess a torn ledger"]);
  }, 30_000);

  it("a hand-picked history: crash, refusal and success use up the cap; raising it allows one more", async () => {
    const commands: Command[] = [call("crash"), call("not-svg"), call("made"), call("made"), { cap: 4, op: "cap" }, call("made"), call("made"), { op: "torn" }, call("made")];
    let why = "";
    const held = await holds({ cap: 3, commands }, (mismatch) => { why = mismatch; });
    expect(why).toBe("");
    expect(held).toBe(true);
  });
});
