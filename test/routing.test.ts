import { readFileSync } from "node:fs";

import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { describe, expect, it } from "vitest";

import { Route as RecordRoute } from "../src/contract.ts";
import { RouteRefused, RoutingTable, resolveRoute, routeRecord } from "../src/routing.ts";

const table = Schema.decodeUnknownSync(RoutingTable)(JSON.parse(readFileSync(new URL("../routing.json", import.meta.url), "utf-8")), { onExcessProperty: "error" });
const concepts = Object.keys(table.scheme.concepts);
const ancestors = (concept: string): readonly string[] => [concept, ...(table.scheme.concepts[concept]?.broader ?? []).flatMap(ancestors)];

const CatalogFileShape = Schema.Struct({ entries: Schema.Array(Schema.Struct({ cellReady: Schema.Boolean, template: Schema.String, version: Schema.Number })) });

describe("work-type routing", () => {
  it("routes every concept to its nearest routed ancestor, and the record route decodes with the contract", () => {
    for (const concept of concepts) {
      const resolved = resolveRoute(table, concept);
      expect(resolved, concept).not.toBeInstanceOf(RouteRefused);
      if (resolved instanceof RouteRefused) {continue;}
      expect(resolved.concept).toBe(ancestors(concept).find((candidate) => Object.hasOwn(table.routes, candidate)));
      expect(Schema.decodeSync(RecordRoute)(routeRecord(resolved))).toEqual(routeRecord(resolved));
    }
  });

  it("refuses anything outside the scheme with a four-line prompt naming every concept", async () => {
    const result = await Effect.runPromise(
      Arbitrary.checkEffect(Arbitrary.schema(Schema.String), (workType) => {
        if (Object.hasOwn(table.scheme.concepts, workType)) {return true;}
        const resolved = resolveRoute(table, workType);
        expect(resolved).toBeInstanceOf(RouteRefused);
        if (!(resolved instanceof RouteRefused)) {return false;}
        expect(resolved.message.split("\n").map((line) => line.split(":")[0])).toEqual(["RouteRefused", "Accepted", "Fix", "Debug"]);
        for (const concept of concepts) {expect(resolved.message).toContain(concept);}
        return true;
      }, { runs: 500 }),
    );
    expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
  });

  it("names only cell-ready catalog templates in peon routes", () => {
    const catalog = Schema.decodeUnknownSync(CatalogFileShape)(JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf-8")));
    const ready = new Set(catalog.entries.filter((entry) => entry.cellReady).map((entry) => `${entry.template}@${entry.version}`));
    for (const [concept, route] of Object.entries(table.routes)) {
      if ("peon" in route.specialist) {expect(ready, `${concept} -> ${route.specialist.peon}`).toContain(route.specialist.peon);}
    }
  });

  it("refuses a concept whose whole path has no route", () => {
    const { work: _root, ...rest } = table.routes;
    expect(resolveRoute({ ...table, routes: rest }, "docs")).toBeInstanceOf(RouteRefused);
  });
});
