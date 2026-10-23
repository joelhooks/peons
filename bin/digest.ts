// digest: compute a template's digest from its rewarm.digestInputs.
//
//   node bin/digest.ts templates/arrows-svg/v1 [--models models.json]
//
// sha256 over canonical JSON of: the Quiver model list (ids and operations),
// the warmup files' hashes, the tool list, the reference hashes and the model id.
// A changed digest means a new version, a canary pass, then a freeze.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { Schema } from "effect";

import { Pending } from "../src/template-node.ts";
import { canonical } from "../src/think-template.ts";

const [dir] = process.argv.slice(2);
if (dir === undefined) {
  console.error("usage: node bin/digest.ts <template dir> [--models <quiver models json>]");
  process.exit(2);
}
const at = process.argv.indexOf("--models");
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

const Template = Schema.Struct({
  profile: Schema.Struct({ model: Schema.String, tools: Schema.Array(Schema.Struct({ name: Schema.String, via: Schema.String })) }),
  warmup: Schema.optionalKey(Schema.Union([Schema.Array(Schema.Struct({ kind: Schema.String, path: Schema.String, sha256: Schema.String })), Pending])),
});
// Entries are read loosely: only Arrow 2+ models need supportedOperations.
const QuiverModels = Schema.Struct({ models: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) });
const Arrow = Schema.Struct({ id: Schema.String, supportedOperations: Schema.Array(Schema.String) });
const isArrow2 = ({ id }: Record<string, unknown>) => typeof id === "string" && /^arrow-(?:[2-9]|[1-9]\d+)/u.test(id);
const isPending = Schema.is(Pending);
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf-8"));

const template = Schema.decodeUnknownSync(Template)(readJson(nodePath.join(dir, "template.json")));
const refs = template.warmup === undefined || isPending(template.warmup) ? [] : template.warmup;
for (const ref of refs) {
  const actual = sha(readFileSync(nodePath.join(dir, ref.path)));
  if (actual !== ref.sha256) {
    console.error(`${ref.path}: sha256 is ${actual}, template says ${ref.sha256}`);
    process.exit(3);
  }
}
const modelsFile = at === -1 ? undefined : process.argv[at + 1];
if (at !== -1 && modelsFile === undefined) {
  console.error("--models needs a Quiver models json file");
  process.exit(2);
}
const models =
  modelsFile === undefined
    ? null
    : Schema.decodeUnknownSync(QuiverModels)(readJson(modelsFile))
        .models.filter(isArrow2)
        .map((m) => Schema.decodeUnknownSync(Arrow)(m))
        .map((m) => ({ id: m.id, ops: [...m.supportedOperations].toSorted() }));

const inputs = {
  "model-id": template.profile.model,
  "quiver-models": models,
  "reference-hashes": refs.filter((r) => r.kind === "reference-render").map((r) => [r.path, r.sha256]),
  "skill-hashes": refs.filter((r) => r.kind === "skill" || r.kind === "model-notes" || r.kind === "doc").map((r) => [r.path, r.sha256]),
  "tool-list": template.profile.tools.map((t) => [t.name, t.via]),
};
console.log(sha(canonical(inputs)));
