import { Effect, Schema } from "effect";

import { RuntimeCapabilities } from "./contract.ts";

export interface Runtime {
  readonly name: string;
  readonly capabilities: readonly string[];
  /** Available slots, not total capacity. */
  readonly slots: number;
}

export type Placement =
  | { readonly status: "placed"; readonly runtime: string }
  | { readonly status: "queued"; readonly reason: "NoCapacity"; readonly requires: readonly string[] };

export class NoRuntimeFor extends Schema.TaggedError<NoRuntimeFor, { readonly brand: unique symbol }>()("NoRuntimeFor", { requires: RuntimeCapabilities }) {
  readonly fix = "call peon_catalog to inspect the requirements; retry the original call once a matching runtime is configured";
}

// A snapshot decision, not a reservation or a queue write. Keep declaration order among free matches.
export const place = ({ requires = [], runtimes }: { readonly requires?: readonly string[]; readonly runtimes: readonly Runtime[] }): Effect.Effect<Placement, NoRuntimeFor> => {
  const matching = runtimes.filter(({ capabilities }) => requires.every((capability) => capabilities.includes(capability)));
  const available = matching.find(({ slots }) => slots > 0);
  if (available !== undefined) {return Effect.succeed({ runtime: available.name, status: "placed" });}
  if (matching.length > 0) {return Effect.succeed({ reason: "NoCapacity", requires, status: "queued" });}
  return Effect.fail(new NoRuntimeFor({ requires }));
};

// Today these compilers can only submit to Mischief. Mischief owns its own capacity; this layer has
// no local cap on submissions. Do not add another runtime here until dispatch can actually select it.
export const mischiefRuntimes: readonly Runtime[] = [{ capabilities: ["linux"], name: "mischief", slots: Infinity }];
