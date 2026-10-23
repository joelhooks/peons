// peon-compile: decode a PeonRequest, load its think template, and print the submitPlan body, or
// the refusal record and exit 4. Refusing here costs nothing.
//
//   node bin/peon-compile.ts templates/change-review/v1 request.json > body.json
import { readFileSync } from "node:fs";

import { Schema } from "effect";

import { PeonRefused, PeonRequest } from "../src/contract.ts";
import { compile, loadTemplate } from "../src/think-template.ts";

const [dir, path] = process.argv.slice(2);
if (dir === undefined || path === undefined) {
  console.error("usage: node bin/peon-compile.ts <template dir> <request.json>");
  process.exit(2);
}
const loaded = loadTemplate(dir);
const request = Schema.decodeUnknownSync(PeonRequest)(JSON.parse(readFileSync(path, "utf-8")));
const result = compile(loaded, request);
if (Schema.is(PeonRefused)(result)) {
  console.log(JSON.stringify(result));
  process.exit(4);
}
console.error(`${loaded.spec.template}@${loaded.spec.version} digest ${loaded.digest} -> ${result.runId}`);
console.log(JSON.stringify({ docs: result.docs, escalateTo: result.escalateTo, plan: result.plan, runId: result.runId }));
