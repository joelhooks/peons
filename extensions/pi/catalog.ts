// What the extension knows before any run: the routing table, catalog.json (peons.catalog.v1) and
// the templates in this repo. A cell-ready catalog entry is runnable when templates/<name>/v<version>
// loads as a think template through think-template.ts, which checks every file hash. A template directory with
// no catalog entry is read as a TemplateNode and listed, never run by peon_run (it is a tool peon,
// like arrows-svg). A template that fails to load is left out and reported, never half-loaded; drift
// between an entry and its template is reported as a problem, never patched.
import { readFile, readdir } from "node:fs/promises";
import nodePath from "node:path";

import { Effect, Result, Schema } from "effect";

import { Catalog as CatalogFile } from "../../src/contract.ts";
import type { CatalogEntry } from "../../src/contract.ts";
import { canonical, issuesOf, nameOf, sha256 } from "../../src/compile.ts";
import { RoutingTable } from "../../src/routing.ts";
import { Pending, TemplateNode, frozen } from "../../src/template-node.ts";
import { loadTemplate } from "../../src/think-template.ts";
import type { LoadedTemplate } from "../../src/think-template.ts";

const isPending = Schema.is(Pending);

// A template directory with no catalog entry: listed by name, version, digest and profile.
export interface Unlisted {
  readonly template: string;
  readonly version: number;
  readonly digest: string;
  readonly model: string;
  readonly thinking: string;
}

export interface Catalog {
  readonly routing: RoutingTable;
  readonly entries: readonly CatalogEntry[];
  readonly think: readonly LoadedTemplate[];
  readonly unlisted: readonly Unlisted[];
  readonly problems: readonly string[];
}

// bin/digest.ts's digest with no Quiver model list.
export const templateDigest = (node: TemplateNode) => {
  const refs = isPending(node.warmup) ? [] : node.warmup;
  const inputs = {
    "model-id": node.profile.model,
    "quiver-models": null,
    "reference-hashes": refs.filter((ref) => ref.kind === "reference-render").map((ref) => [ref.path, ref.sha256]),
    "skill-hashes": refs.filter((ref) => ref.kind === "skill" || ref.kind === "model-notes" || ref.kind === "doc").map((ref) => [ref.path, ref.sha256]),
    "tool-list": node.profile.tools.map((tool) => [tool.name, tool.via]),
  };
  return sha256(canonical(inputs));
};

const read = (path: string) => Effect.tryPromise({ catch: () => `${path} is unreadable`, try: async () => await readFile(path) });
const list = (path: string) => Effect.tryPromise({ catch: () => `${path} is unreadable`, try: async () => await readdir(path) }).pipe(Effect.orElseSucceed((): string[] => []));

const reason = (error: unknown) => {
  if (Schema.isSchemaError(error)) {return issuesOf(error);}
  if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "TemplateCorrupt" && "path" in error) {return `${String(error.path)} does not match its recorded sha256`;}
  return "it is unreadable";
};

const loadThink = (dir: string) => Effect.try({ catch: (error) => `${dir} does not load as a think template: ${reason(error)}`, try: () => loadTemplate(dir) });

const loadUnlisted = (dir: string) =>
  Effect.gen(function* loadUnlistedGen() {
    const raw = yield* read(nodePath.join(dir, "template.json"));
    const node = Schema.decodeUnknownResult(Schema.fromJsonString(TemplateNode), { errors: "all" })(raw.toString("utf-8"));
    if (Result.isFailure(node)) {return yield* Effect.fail(`${dir}/template.json has no catalog entry and does not decode as a TemplateNode: ${issuesOf(node.failure)}`);}
    if (!frozen(node.success)) {return yield* Effect.fail(`${dir} is not frozen yet (warmup, canary or budget pending)`);}
    for (const ref of isPending(node.success.warmup) ? [] : node.success.warmup) {
      if (sha256(yield* read(nodePath.join(dir, ref.path))) !== ref.sha256) {return yield* Effect.fail(`${dir}/${ref.path} does not match its recorded sha256`);}
    }
    const { template, version, profile } = node.success;
    return { digest: templateDigest(node.success), model: profile.model, template, thinking: profile.thinking, version } satisfies Unlisted;
  });

const drift = (entry: CatalogEntry, loaded: LoadedTemplate) => {
  const at = nameOf(entry.template, entry.version);
  return [
    ...(entry.model === loaded.spec.profile.model && entry.thinking === loaded.spec.profile.thinking ? [] : [`${at}: catalog.json says ${entry.model} ${entry.thinking}, its template says ${loaded.spec.profile.model} ${loaded.spec.profile.thinking}; the template runs`]),
    ...(entry.kind === loaded.spec.kind ? [] : [`${at}: catalog.json kind ${entry.kind}, template kind ${loaded.spec.kind}`]),
  ];
};

const decodeFile = <S extends Schema.Top & { readonly DecodingServices: never }>(root: string, name: string, schema: S) =>
  read(nodePath.join(root, name)).pipe(
    Effect.flatMap((raw) => {
      const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(schema), { errors: "all", onExcessProperty: "error" })(raw.toString("utf-8"));
      return Result.isFailure(decoded) ? Effect.fail(`${name} does not decode: ${issuesOf(decoded.failure)}`) : Effect.succeed<S["Type"]>(decoded.success);
    }),
  );

export const loadCatalog = (root: string): Effect.Effect<Catalog, string> =>
  Effect.gen(function* loadCatalogGen() {
    const routing = yield* decodeFile(root, "routing.json", RoutingTable);
    const file = yield* decodeFile(root, "catalog.json", CatalogFile);
    const think: LoadedTemplate[] = [];
    const unlisted: Unlisted[] = [];
    const problems: string[] = [];
    const listed = new Set(file.entries.map(({ template, version }) => nameOf(template, version)));
    for (const entry of file.entries) {
      const dir = nodePath.join(root, "templates", entry.template, `v${entry.version}`);
      if (!(yield* list(nodePath.join(root, "templates", entry.template))).includes(`v${entry.version}`)) {continue;}
      if (!entry.cellReady) {
        problems.push(`${nameOf(entry.template, entry.version)} has a template but is not cell-ready (needs ${entry.needs.join(", ")}); peon_run will not run it`);
        continue;
      }
      const loaded = yield* Effect.result(loadThink(dir));
      if (Result.isFailure(loaded)) {problems.push(loaded.failure);}
      else {
        think.push(loaded.success);
        problems.push(...drift(entry, loaded.success));
      }
    }
    for (const name of (yield* list(nodePath.join(root, "templates"))).toSorted()) {
      for (const version of (yield* list(nodePath.join(root, "templates", name))).filter((entry) => /^v[1-9][0-9]*$/u.test(entry)).toSorted()) {
        if (listed.has(nameOf(name, Number(version.slice(1))))) {continue;}
        const loaded = yield* Effect.result(loadUnlisted(nodePath.join(root, "templates", name, version)));
        if (Result.isSuccess(loaded)) {unlisted.push(loaded.success);}
        else {problems.push(loaded.failure);}
      }
    }
    return { entries: file.entries, problems, routing, think, unlisted };
  });
