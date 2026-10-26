import { Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { describe, expect, it } from "vitest";

import { canonical, sha256 } from "../src/compile.ts";
import { prepare, priceUsd } from "../src/quiver.ts";
import { resolveRoute, Route, RouteRefused, routeRecord } from "../src/routing.ts";
import { decideSpend, parseLedger } from "../src/spend.ts";
import type { LedgerFact } from "../src/spend.ts";
import { forAll, int, pick, routing } from "./support.ts";

const small = Schema.Int.check(Schema.isBetween({ maximum: 20, minimum: 0 }));
const counts = Arbitrary.schema(Schema.Struct({ cap: small, reserved: small, settled: small }));
const reservations = (count: number): LedgerFact[] => Array.from({ length: count }, (_, i) => ({ at: "t", event: "reserved", model: "arrow-2", requestId: `r${i}` }));
const tokens = Arbitrary.schema(Schema.Struct({ cached: small, output: small, uncached: small }));
const pair = Arbitrary.schema(Schema.Struct({ a: small, b: small }));
const route = Schema.decodeSync(Route)({ source: "test", specialist: { peon: "fix@1" }, status: "provisional", why: "fixture" });

// Return booleans (rather than throw assertions inside the callback) so forAll can
// shrink a counterexample and print the smallest input it found.
describe("spend invariants", () => {
  it("counts reservations exactly, including the cap boundary", async () => {
    expect(await forAll(counts, ({ cap, reserved }) => canonical(decideSpend(reservations(reserved), cap)) === canonical(reserved >= cap ? { cap, kind: "exhausted", used: reserved } : { call: reserved + 1, cap, kind: "allowed" }))).toBeUndefined();
  });

  it("settlements neither refund nor consume reservations", async () => {
    expect(await forAll(counts, ({ cap, reserved, settled }) => {
      const facts: LedgerFact[] = [...reservations(reserved), ...Array.from({ length: settled }, (_, i) => ({ at: "t", event: "settled" as const, listCostUsd: i / 100, requestId: `r${i}` }))];
      return canonical(decideSpend(facts, cap)) === canonical(decideSpend(reservations(reserved), cap));
    })).toBeUndefined();
  });

  it("refusals do not consume a call even alongside existing reservations", async () => {
    expect(await forAll(counts, ({ cap, reserved, settled }) => {
      const facts: LedgerFact[] = [...reservations(reserved), ...Array.from({ length: settled }, (_, i) => ({ at: "t", event: "refused" as const, refusal: "not-svg" as const, requestId: `no${i}` }))];
      return canonical(decideSpend(facts, cap)) === canonical(decideSpend(reservations(reserved), cap));
    })).toBeUndefined();
  });

  it("ledger JSON lines preserve order, duplicates and all event payloads", async () => {
    expect(await forAll(counts, ({ cap, reserved, settled }) => {
      const facts: LedgerFact[] = [...reservations(reserved), { at: "t", event: "settled", listCostUsd: settled / 100, requestId: "r0" }, { at: "t", event: "refused", refusal: "not-svg", requestId: `no${cap}` }];
      return canonical(parseLedger(`\n ${facts.map((fact) => JSON.stringify(fact)).join("\n\n")}\n`)) === canonical(facts);
    })).toBeUndefined();
  });
});

describe("Quiver invariants", () => {
  it("prices both known models by uncached, cached and output token rates", async () => {
    expect(await forAll(tokens, ({ cached, uncached, output }) => ["arrow-2", "arrow-2-telos"].every((model) => {
      const rate = model === "arrow-2" ? 4 : 6;
      const actual = priceUsd(model, { cacheRead: cached, input: uncached + cached, output });
      return Math.abs(actual - (uncached * rate + cached * rate / 10 + output * rate * 5) / 1_000_000) < 1e-12;
    }))).toBeUndefined();
  });

  it("moving input into cache saves exactly ninety percent of its input price", async () => {
    expect(await forAll(tokens, ({ cached, uncached, output }) => {
      const full = priceUsd("arrow-2", { cacheRead: 0, input: uncached + cached, output });
      const discounted = priceUsd("arrow-2", { cacheRead: cached, input: uncached + cached, output });
      return Math.abs(full - discounted - cached * 3.6 / 1_000_000) < 1e-12;
    })).toBeUndefined();
  });

  it("maps every optional request field to its provider spelling without dropping zero", async () => {
    expect(await forAll(Arbitrary.schema(Schema.Struct({ effort: Schema.Literals(["low", "medium", "high"]), n: small })), async ({ effort, n }) => {
      const request = await prepare({ instructions: `rule${n}`, maxOutputTokens: n + 1, model: "arrow-2", prompt: `prompt${n}`, reasoningEffort: effort, requestId: `r${n}`, temperature: n / 10 });
      return canonical(request) === canonical({ body: { instructions: `rule${n}`, max_output_tokens: n + 1, model: "arrow-2", n: 1, prompt: `prompt${n}`, reasoning_effort: effort, stream: false, temperature: n / 10 }, model: "arrow-2" });
    })).toBeUndefined();
  });

  it("omits absent options and empty references rather than sending provider defaults", async () => {
    expect(await forAll(int(0, 20), async (n) => {
      const job = { model: "arrow-2-telos", prompt: `p${n}`, requestId: `r${n}` };
      const expected = canonical({ body: { model: job.model, n: 1, prompt: job.prompt, stream: false }, model: job.model });
      return canonical(await prepare(job)) === expected && canonical(await prepare({ ...job, references: [] })) === expected;
    })).toBeUndefined();
  });

  it("keeps local request identifiers out of provider payloads", async () => {
    expect(await forAll(pair, async ({ a, b }) => {
      const job = { model: "arrow-2", prompt: `p${a}` };
      return canonical(await prepare({ ...job, requestId: `first${a}` })) === canonical(await prepare({ ...job, requestId: `second${b}` }));
    })).toBeUndefined();
  });
});

describe("routing invariants", () => {
  it("chooses the nearest routed ancestor on generated chains", async () => {
    expect(await forAll(pair, ({ a, b }) => {
      const distance = a + 1;
      const concepts = Object.fromEntries(Array.from({ length: distance + 1 }, (_, i) => [`c${i}`, { broader: i < distance ? [`c${i + 1}`] : [] }]));
      const nearest = b % (distance + 1);
      const table = { ...routing, routes: { [`c${nearest}`]: route, [`c${distance}`]: route }, scheme: { ...routing.scheme, concepts } };
      const resolved = resolveRoute(table, "c0");
      return !(resolved instanceof RouteRefused) && resolved.concept === `c${nearest}` && canonical(routeRecord(resolved)) === canonical({ concept: `c${nearest}`, specialist: route.specialist, status: route.status, tableVersion: table.version });
    })).toBeUndefined();
  });

  it("searches breadth first before deeper routes on the first branch", async () => {
    expect(await forAll(int(0, 20), (version) => {
      const table = { ...routing, routes: { deep: route, near: route }, scheme: { ...routing.scheme, concepts: { deep: { broader: [] }, left: { broader: ["deep"] }, near: { broader: [] }, root: { broader: ["left", "near"] } } }, version };
      const result = resolveRoute(table, "root");
      return !(result instanceof RouteRefused) && result.concept === "near" && result.tableVersion === version && canonical(resolveRoute(table, "root")) === canonical(result);
    })).toBeUndefined();
  });

  it("terminates cycles without routes and sorts the accepted route names", async () => {
    expect(await forAll(int(1, 20), (length) => {
      const concepts = Object.fromEntries(Array.from({ length }, (_, i) => [`c${i}`, { broader: [`c${(i + 1) % length}`] }]));
      const result = resolveRoute({ ...routing, routes: Object.fromEntries([["z", route], ["a", route]]), scheme: { ...routing.scheme, concepts } }, "c0");
      return result instanceof RouteRefused && canonical(result.accepted) === canonical(["a", "z"]);
    })).toBeUndefined();
  });
});

describe("canonical digest invariants", () => {
  it("ignores object insertion order recursively when hashing a plan", async () => {
    expect(await forAll(pair, ({ a, b }) => {
      const reversed = Object.fromEntries([["b", b], ["a", a]]);
      return sha256(canonical(Object.fromEntries([["z", reversed], ["a", [reversed]]]))) === sha256(canonical({ a: [{ a, b }], z: { a, b } }));
    })).toBeUndefined();
  });

  it("omits undefined object fields at every depth", async () => {
    expect(await forAll(pair, ({ a, b }) => canonical({ a, absent: undefined, nested: { absent: undefined, b } }) === canonical({ a, nested: { b } }))).toBeUndefined();
  });

  it("preserves array order and changes the digest when an ordered input changes", async () => {
    expect(await forAll(pick("subject", "criteria", "evidence"), (key) => {
      const before = { inputs: [key, `${key}-next`] };
      const after = { inputs: [`${key}-next`, key] };
      return canonical(before) === JSON.stringify(before) && sha256(canonical(before)) !== sha256(canonical(after));
    })).toBeUndefined();
  });
});
