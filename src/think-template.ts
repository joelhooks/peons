// A think template: one Mischief think, warmed with seeded docs, that reads the caller's docs and
// writes one verdict doc. Content is identity: the digest covers the spec and every file it names.
// compile is pure and refuses before anything is spent.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { Schema } from "effect";

import type { PeonRequest } from "./contract.ts";
import { PeonRefused } from "./contract.ts";
import { VerdictName } from "./verdicts.ts";

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Slug = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,47}$/u));
const DocName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/u));
const RelPath = Schema.String.check(Schema.isPattern(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/u));

export const ThinkModel = Schema.Literals(["sol", "gpt-6-luna"]);

export const ThinkTemplate = Schema.Struct({
  inputs: Schema.NonEmptyArray(
    Schema.Struct({ doc: DocName, maxBytes: Schema.Int.check(Schema.isBetween({ maximum: 600_000, minimum: 1 })), required: Schema.Boolean }),
  ),
  kind: Schema.Literals(["read", "judge"]),
  maxSteps: Schema.Int.check(Schema.isBetween({ maximum: 16, minimum: 2 })),
  output: Schema.Struct({ doc: DocName, verdict: VerdictName }),
  owner: Schema.String,
  profile: Schema.Struct({ model: ThinkModel, thinking: Schema.Literals(["low", "medium", "high", "xhigh", "max"]) }),
  prompt: Schema.Struct({ path: RelPath, sha256: Sha256 }),
  schema: Schema.Literal("peons.think-template.v1"),
  template: Slug,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  warmup: Schema.NonEmptyArray(Schema.Struct({ doc: DocName, path: RelPath, sha256: Sha256 })),
});

export type ThinkTemplate = typeof ThinkTemplate.Type;

export interface LoadedTemplate {
  readonly spec: ThinkTemplate;
  readonly digest: string;
  readonly warmup: Readonly<Record<string, string>>;
  readonly prompt: string;
}

export const COMPILER = "peons.think-compile.v1";

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export const byKey = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]): number => Number(a > b) - Number(a < b);

export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {return `[${value.map(canonical).join(",")}]`;}
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).toSorted(byKey).map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export class TemplateCorrupt extends Schema.TaggedError<TemplateCorrupt, { readonly brand: unique symbol }>()("TemplateCorrupt", { path: Schema.String, reason: Schema.String }) {}

export const loadTemplate = (dir: string): LoadedTemplate => {
  const spec = Schema.decodeUnknownSync(ThinkTemplate)(JSON.parse(readFileSync(nodePath.join(dir, "template.json"), "utf-8")));
  const read = (path: string, expected: string) => {
    const bytes = readFileSync(nodePath.join(dir, path));
    if (sha(bytes) !== expected) {
      throw new TemplateCorrupt({ path, reason: `sha256 is ${sha(bytes)}, template says ${expected}` });
    }
    return bytes.toString("utf-8");
  };
  const warmup = Object.fromEntries(spec.warmup.map((ref) => [ref.doc, read(ref.path, ref.sha256)]));
  const prompt = read(spec.prompt.path, spec.prompt.sha256);
  return { digest: sha(canonical({ compiler: COMPILER, spec })), prompt, spec, warmup };
};

export const mischiefRunId = (desk: string, runId: string) => `peon-${sha(`${desk}\n${runId}`).slice(0, 40)}`;

export const promptOf = (prompt: string, reads: readonly string[]) =>
  [...reads.map((name) => `## ${name}\n\n{{docs.${name}}}`), `## task\n\n${prompt}`].join("\n\n");

export interface Compiled {
  readonly runId: string;
  readonly plan: unknown;
  readonly docs: Readonly<Record<string, string>>;
  readonly escalateTo: string;
}

const refuse = (request: PeonRequest, tag: string, accepted: string, fix: string, debug: string) =>
  Schema.decodeSync(PeonRefused)({
    accepted,
    debug,
    desk: request.desk,
    fix,
    route: null,
    runId: request.runId,
    schema: "peons.record.v1",
    tag,
    template: request.target.kind === "template" ? request.target.template : request.target.workType.replaceAll("_", "-"),
    type: "peon.refused",
  });

export const compile = (loaded: LoadedTemplate, request: PeonRequest): Compiled | typeof PeonRefused.Type => {
  const { spec } = loaded;
  const named = `${spec.template}@${spec.version}`;

  if (request.target.kind !== "template" || request.target.template !== spec.template || (request.target.version !== null && request.target.version !== spec.version)) {
    return refuse(request, "TemplateMismatch", named, `peon_run({ target: { kind: "template", template: "${spec.template}", version: ${spec.version} } }), or resolve the route to this template first`, `asked for ${JSON.stringify(request.target)}`);
  }

  if (request.input.kind !== "brief") {
    return refuse(request, "EventNotAccepted", "a brief with docs", `send { kind: "brief", text, docs } with docs ${spec.inputs.map((input) => input.doc).join(", ")}`, `${named} declares no event schema`);
  }

  const { docs, text } = request.input;
  const declared = new Set(spec.inputs.map((input) => input.doc));
  const unknown = Object.keys(docs).filter((name) => !declared.has(name)).toSorted();

  if (unknown.length > 0) {
    return refuse(request, "UnknownInput", [...declared].join(", "), `drop or rename ${unknown.join(", ")}`, `${named} reads only declared docs`);
  }

  for (const input of spec.inputs) {
    const value = docs[input.doc];
    if (value === undefined) {
      if (input.required) {
        return refuse(request, "MissingInput", [...declared].join(", "), `add docs.${input.doc}`, `${named} requires ${input.doc}`);
      }
      continue;
    }
    const bytes = Buffer.byteLength(value, "utf-8");
    if (bytes > input.maxBytes) {
      return refuse(request, "InputTooLarge", `${input.doc} up to ${input.maxBytes} bytes`, `trim docs.${input.doc} or split the request`, `${input.doc} is ${bytes} bytes`);
    }
  }

  const runId = mischiefRunId(request.desk, request.runId);
  const reads = [...spec.warmup.map((ref) => ref.doc), "brief", ...spec.inputs.map((input) => input.doc).filter((name) => docs[name] !== undefined)];
  const plan = {
    defaults: { agent: { model: spec.profile.model, thinking: spec.profile.thinking } },
    envelope: {
      maxAgents: 1,
      maxDepth: 3,
      maxSteps: spec.maxSteps,
      maxThinking: spec.profile.thinking,
      models: [spec.profile.model],
      names: [],
      thresholds: { judge: 0.8 },
    },
    goal: `${named} (${loaded.digest.slice(0, 12)}) for ${request.desk}`,
    id: runId,
    machine: {
      id: runId,
      initial: "peon",
      states: {
        done: { type: "final" },
        peon: { meta: { step: { kind: "think", prompt: promptOf(loaded.prompt, reads), writes: spec.output.doc } }, on: { done: { target: "done" } } },
      },
    },
  };

  return { docs: { ...loaded.warmup, ...docs, brief: text }, escalateTo: request.desk, plan, runId };
};
