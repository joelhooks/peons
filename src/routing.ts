// Work type to specialist. Routes are data in routing.json, owned by the agent-graph desk; a desk
// tool and a workflow node both resolve through resolveRoute, so they pick the same specialist.
// A route is a measured template or, until one exists, a provisional model profile. routeRecord is
// the one way a resolved route becomes the contract's Route on a request or record.
import { Schema } from "effect";

import { Route as RecordRoute } from "./contract.ts";

const Concept = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,47}$/u));

export const Specialist = RecordRoute.fields.specialist;

export const Route = Schema.Struct({
  source: Schema.NonEmptyString,
  specialist: Specialist,
  status: Schema.Literals(["provisional", "measured"]),
  why: Schema.NonEmptyString,
});

export const RoutingTable = Schema.Struct({
  routes: Schema.Record(Concept, Route),
  schema: Schema.Literal("agent-graph.routing.v0.1"),
  scheme: Schema.Struct({
    concepts: Schema.Record(Concept, Schema.Struct({ broader: Schema.Array(Concept) })),
    id: Schema.String,
    version: Schema.Int,
  }),
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type RoutingTable = typeof RoutingTable.Type;
export type Route = typeof Route.Type;
export interface Resolved { readonly concept: string; readonly route: Route; readonly tableVersion: number }

export class RouteRefused extends Schema.TaggedError<RouteRefused>()("RouteRefused", {
  accepted: Schema.Array(Schema.String),
  reason: Schema.String,
  workType: Schema.String,
}) {
  override get message(): string {
    return [
      `RouteRefused: you asked for a specialist for work type ${JSON.stringify(this.workType)}, and it failed because ${this.reason}`,
      `Accepted: ${this.accepted.join(", ")}`,
      `Fix: call peon_run({ workType: "<one accepted concept>" }), or name a template with peon_run({ peon: "<template>@<version>" })`,
      "Debug: read routing.json in joelhooks/peons",
    ].join("\n");
  }
}

export const resolveRoute = (table: RoutingTable, workType: string): Resolved | RouteRefused => {
  const {concepts} = table.scheme;
  if (!Object.hasOwn(concepts, workType)) {return new RouteRefused({ accepted: Object.keys(concepts).toSorted(), reason: "it is not a concept in the work-type scheme", workType });}
  const seen = new Set<string>();
  for (let frontier = [workType]; frontier.length > 0;) {
    const next: string[] = [];
    for (const concept of frontier) {
      if (seen.has(concept)) {continue;}
      seen.add(concept);
      const route = Object.hasOwn(table.routes, concept) ? table.routes[concept] : undefined;
      if (route) {return { concept, route, tableVersion: table.version };}
      next.push(...(concepts[concept]?.broader ?? []));
    }
    frontier = next;
  }
  return new RouteRefused({ accepted: Object.keys(table.routes).toSorted(), reason: "neither it nor any broader concept has a route", workType });
};

export const routeRecord = (resolved: Resolved): typeof RecordRoute.Type => ({
  concept: resolved.concept,
  specialist: resolved.route.specialist,
  status: resolved.route.status,
  tableVersion: resolved.tableVersion,
});
