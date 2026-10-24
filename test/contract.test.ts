import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { describe, expect, it } from "vitest";

import { CatalogEntry, PeonRecord, PeonRequest, PeonRunResult, cellReady } from "../src/contract.ts";

const roundTrips = async (schema: Schema.Codec<unknown, unknown>) => {
  const codec = Schema.toCodecJson(schema);
  const decode = Schema.decodeUnknownSync(codec);
  const encode = Schema.encodeSync(codec);
  const result = await Effect.runPromise(
    Arbitrary.checkEffect(Arbitrary.schema(schema), (value) => {
      const wire = JSON.stringify(encode(value));
      expect(JSON.stringify(encode(decode(JSON.parse(wire))))).toBe(wire);
      return true;
    }, { runs: 200 }),
  );
  expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
};

describe("peon contract", () => {
  it("every request survives the wire", async () => {
    await roundTrips(PeonRequest);
  });
  it("every queue record survives the wire", async () => {
    await roundTrips(PeonRecord);
  });
  it("a re-sent runId answers with a handle or the stored record", async () => {
    await roundTrips(PeonRunResult);
  });
  it("every catalog entry survives the wire", async () => {
    await roundTrips(CatalogEntry);
  });

  it("refuses a record without the four-line failure shape", () => {
    expect(() =>
      Schema.decodeSync(PeonRecord)({ accepted: "", debug: "y", desk: "front-desk/desk", fix: "x", route: null, runId: "r1", schema: "peons.record.v1", tag: "NoScope", template: "scout", type: "peon.refused" }),
    ).toThrow();
  });

  it("accepts PascalCase and kebab tags and workflow node run ids", () => {
    const refused = { accepted: "a", debug: "c", desk: "front-desk/desk", fix: "b", route: null, runId: "wf-1/node-a#2", schema: "peons.record.v1", template: "scout", type: "peon.refused" };
    for (const tag of ["RouteRefused", "no-scope"]) {
      expect(Schema.decodeUnknownSync(PeonRecord)({ ...refused, tag }).runId).toBe("wf-1/node-a#2");
    }
    expect(() => Schema.decodeUnknownSync(PeonRecord)({ ...refused, tag: "Bad Tag" })).toThrow();
    expect(() => Schema.decodeUnknownSync(PeonRecord)({ ...refused, schema: "peons.record.v2", tag: "x" })).toThrow();
  });

  it("a peon is cell-ready only when it needs no shell, git, network, secrets or browser", () => {
    expect(cellReady(["model-only"])).toBe(true);
    expect(cellReady(["read-only", "model-only"])).toBe(true);
    for (const need of ["shell", "git-commit", "network", "secrets", "browser"] as const) {
      expect(cellReady(["read-only", need])).toBe(false);
    }
  });
});
