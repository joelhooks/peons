// The desk tools, as Effects over the run-host port. Every input decodes with Effect Schema where it
// enters; every refusal is a 4-line prompt; every result is a contract handle or record. The tools
// never send mail, archive, push, deploy or start a timer: a wait is the caller's watch over
// peon_status.
//
// Idempotency is Mischief's. peon_run and workflow_run derive the Mischief run id from (desk, runId),
// inspect it, and submit only when the host has no such run, so a crash anywhere between submit and
// the record costs no second submit. Nothing is cached locally.
import nodePath from "node:path";

import { Effect, Option, Result, Schema } from "effect";

import { PeonRequest, Check } from "../../src/contract.ts";
import { FROZEN_DOC, GATEWAY_MODELS, Prompt, canonical, compileRun, findThink, issuesOf, mischiefRunId, nameOf, prompt, sha256, thinkNames } from "../../src/compile.ts";
import type { Compiled, FrozenStep } from "../../src/compile.ts";
import { RouteRefused, resolveRoute } from "../../src/routing.ts";
import type { Resolved } from "../../src/routing.ts";
import { decodeVerdict, docText, escalationId, fromRunReport, frozenOf } from "../../src/run-report.ts";
import { quotesOf, verifyQuotes } from "../../src/verdicts.ts";
import type { verdicts } from "../../src/verdicts.ts";
import type { Addressed, PeonRunResult, RunReport, SubmitRefused } from "../../src/run-report.ts";
import { decodeDefinedWorkflow, defineWorkflow, failurePolicies, gates, stepKinds, workflowRun } from "../../src/workflow.ts";
import type { LoadedTemplate } from "../../src/think-template.ts";
import type { Catalog } from "./catalog.ts";
import type { RunHostPort } from "./host.ts";

export interface ToolOutput {
  readonly text: string;
  readonly data: unknown;
  readonly isError: boolean;
}

export interface Files {
  readonly read: (path: string) => Effect.Effect<Uint8Array | null, Prompt>;
  readonly write: (path: string, text: string) => Effect.Effect<void, Prompt>;
}

export interface ToolDeps {
  readonly host: Effect.Effect<RunHostPort, Prompt>;
  readonly desk: Effect.Effect<string, Prompt>;
  readonly catalog: Catalog;
  readonly files: Files;
  readonly cwd: string;
}

const DEBUG = "read extensions/pi/tools.ts in joelhooks/peons";
const SWARM_MAX = 64;
const SWARM_MODELS = ["sol", "luna", "opus"] as const;
const SWARM_DIR = ".peons/swarms";
const NonEmpty = Schema.String.check(Schema.isMinLength(1));

const refusal = (refused: Prompt): ToolOutput => ({ data: { tag: refused.tag }, isError: true, text: refused.message });

const params = <S extends Schema.Top & { readonly DecodingServices: never }>(tool: string, schema: S, shape: string) => (raw: unknown): Effect.Effect<S["Type"], Prompt> => {
  const decoded = Schema.decodeUnknownResult(schema, { errors: "all", onExcessProperty: "error" })(raw);
  return Result.isFailure(decoded)
    ? Effect.fail(prompt({ accepted: shape, debug: DEBUG, did: `called ${tool}`, fix: `call ${tool}(${shape})`, tag: "ParamsRefused", why: `its arguments do not decode: ${issuesOf(decoded.failure)}` }))
    : Effect.succeed(decoded.success);
};

const resultText = (result: PeonRunResult): string => {
  if (!("type" in result)) {return `🪓 running · ${result.runId} · ${result.template === null ? "no template" : nameOf(result.template.template, result.template.version)}. Watch it with peon_status({ runId: ${JSON.stringify(result.runId)} }).`;}
  if (result.type === "peon.done") {
    return `✅ done · ${result.runId} · artifact ${result.artifact.kind === "doc" ? result.artifact.name : "artifact"} sha256 ${result.artifact.kind === "commit" ? result.artifact.sha : result.artifact.sha256}. Check it with peon_verify.`;
  }
  if (result.type === "peon.blocked") {
    return `⏸ blocked · ${result.runId} · step ${result.step} · message ${result.messageId}\n${result.question}${result.choices.length === 0 ? "" : `\nChoices: ${result.choices.join(", ")}`}`;
  }
  if (result.type === "peon.failed") {
    return `${result.tag}: run ${result.runId} failed at step ${result.step}\nAccepted: ${result.accepted}\nFix: ${result.fix}\nDebug: ${result.debug}`;
  }
  return `${result.tag}: run ${result.runId} was refused before it started\nAccepted: ${result.accepted}\nFix: ${result.fix}\nDebug: ${result.debug}`;
};

const output = (result: PeonRunResult, extra: Record<string, unknown> = {}): ToolOutput => ({
  data: { result, ...extra },
  isError: "type" in result && result.type === "peon.refused",
  text: resultText(result),
});

const refusedRecord = (request: Addressed, template: string, route: FrozenStep["route"], refused: Prompt): PeonRunResult => ({
  accepted: refused.accepted,
  debug: `${refused.why}. ${refused.debug}`,
  desk: request.desk,
  fix: refused.fix,
  route,
  runId: request.runId,
  schema: "peons.record.v1",
  tag: refused.tag,
  template,
  type: "peon.refused",
});

// Inspect first, submit only when the host has no such run. A host lookup, not a local cache, is what
// makes this safe across a crash.
export const submitOnce = (host: RunHostPort, compiled: Compiled, request: Addressed, refusedTemplate: string, route: FrozenStep["route"]) =>
  Effect.gen(function* submitOnceGen() {
    const existing = yield* host.inspect(compiled.runId).pipe(
      Effect.asSome,
      Effect.catchTag("UnknownRun", () => Effect.succeed(Option.none<RunReport>())),
    );
    if (Option.isSome(existing)) {return fromRunReport(existing.value, request);}
    const submitted: RunReport | SubmitRefused = yield* host.submit(compiled.runId, compiled.plan, compiled.docs).pipe(
      Effect.catchTag("PlanRefused", (refused) => Effect.succeed<SubmitRefused>({ errors: refused.errors, kind: "submit-refused", route, template: refusedTemplate })),
    );
    return fromRunReport(submitted, request);
  });

const hostFailure = (tool: string) => (failure: { readonly message: string }) =>
  Effect.succeed<ToolOutput>({ data: { tag: "HostFailure" }, isError: true, text: failure.message.startsWith("HostFailure:") ? failure.message : `HostFailure: you called ${tool}, and it failed because ${failure.message}\nAccepted: a reachable Mischief worker\nFix: retry the same call\nDebug: ${DEBUG}` });

const finish = (tool: string) => (effect: Effect.Effect<ToolOutput, Prompt | { readonly _tag: "HostFailure"; readonly message: string }>) =>
  effect.pipe(
    Effect.catchTags({
      HostFailure: hostFailure(tool),
      Prompt: (refused) => Effect.succeed(refusal(refused)),
    }),
  );

const RUN_SHAPE = '{ workType: "<concept>" | peon: "<template>[@<version>]", brief: "<text>", docs?: { <slug>: "<text>" } | event: { name, data }, base?: { repo, sha }, scope?: ["<path>"], runId?: "<id>" }';
const RunParams = Schema.Struct({
  base: Schema.optionalKey(Schema.Struct({ repo: Schema.String, sha: Schema.String })),
  brief: Schema.optionalKey(Schema.String),
  docs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  event: Schema.optionalKey(Schema.Struct({ data: Schema.Json, name: Schema.String })),
  model: Schema.optionalKey(Schema.Literals(SWARM_MODELS)),
  peon: Schema.optionalKey(Schema.String),
  runId: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.Array(Schema.String)),
  workType: Schema.optionalKey(Schema.String),
});

const SwarmJob = Schema.Struct({ digest: Schema.String, runId: Schema.String });
const SwarmManifest = Schema.Union([
  Schema.Struct({ runIds: Schema.Array(Schema.String), schema: Schema.Literal("peons.swarm.v1"), swarmId: Schema.String }),
  Schema.Struct({ jobs: Schema.Array(SwarmJob), schema: Schema.Literal("peons.swarm.v2"), swarmId: Schema.String }),
]);
const swarmRunIds = (manifest: typeof SwarmManifest.Type): readonly string[] => ("jobs" in manifest ? manifest.jobs.map(({ runId }) => runId) : manifest.runIds);

const SWARM_SHAPE = `{ jobs: [${RUN_SHAPE}, ...] (1 to ${SWARM_MAX}), swarmId?: "<id>" }`;
const SwarmParams = Schema.Struct({
  jobs: Schema.Array(RunParams).check(Schema.isMinLength(1), Schema.isMaxLength(SWARM_MAX)),
  swarmId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/u))),
});

// Routing names provider/model refs; Mischief's gateway takes only its own aliases, so a {profile}
// route maps here, before compile, and the frozen record names the model that really runs.
const GATEWAY_OF: Readonly<Record<string, string>> = {
  "claude-bridge/claude-opus-5-5": "opus",
  "openai-codex/gpt-6-luna": "luna",
  "openai-codex/gpt-6.1-sol": "sol",
};
const onGatewayModel = (model: string) => (GATEWAY_MODELS.some((name) => name === model) ? model : GATEWAY_OF[model]);

const modelRefused = (why: string, fix: string) => prompt({ accepted: `a route on ${Object.keys(GATEWAY_OF).join(", ")} or a gateway alias (${GATEWAY_MODELS.join(", ")}); model override one of ${SWARM_MODELS.join(", ")}`, debug: "read GATEWAY_OF in extensions/pi/tools.ts and GATEWAY_MODELS in mischief packages/thinking/src/gateway.ts", did: "asked to run a peon on Mischief's gateway", fix, tag: "ModelRefused", why: `${why}. opus runs only where the host sets the Opus bridge (celld does)` });

const routeOf = (resolved: Resolved | null): FrozenStep["route"] => (resolved === null ? null : { concept: resolved.concept, specialist: resolved.route.specialist, status: resolved.route.status, tableVersion: resolved.tableVersion });

const swarmKind = (result: PeonRunResult | null): string => {
  if (result === null) {return "missing";}
  return "type" in result ? result.type.replace("peon.", "") : "running";
};

export const onGateway = (resolved: Resolved | null, loaded: LoadedTemplate | null, model?: string): Resolved | null | Prompt => {
  if (loaded !== null) {
    return model === undefined || model === loaded.spec.profile.model ? resolved : modelRefused(`template ${loaded.spec.template}@${loaded.spec.version} pins model ${loaded.spec.profile.model}, and the job asked for ${model}`, "drop model from the job, or use a workType route instead of the template");
  }
  if (resolved === null || !("profile" in resolved.route.specialist)) {return resolved;}
  const { profile } = resolved.route.specialist;
  const mapped = model ?? onGatewayModel(profile.model);
  if (mapped === undefined) {return modelRefused(`the ${resolved.concept} route runs ${profile.model}, which Mischief's gateway does not serve`, `pass model: "sol" (or "opus") on the job, or move the ${resolved.concept} route to a gateway model in routing.json`);}
  return { ...resolved, route: { ...resolved.route, specialist: { profile: { ...profile, model: mapped } } } };
};

const INPUT_SHAPE = 'brief: "<text>", docs?: { <slug>: "<text>" } | event: { name, data }';
const InputParams = { brief: RunParams.fields.brief, docs: RunParams.fields.docs, event: RunParams.fields.event };

const inputOf = (tool: string, given: { readonly brief?: string; readonly docs?: Readonly<Record<string, string>>; readonly event?: { readonly name: string; readonly data: Schema.Json } }) =>
  (given.brief === undefined) === (given.event === undefined)
    ? Effect.fail(prompt({ accepted: INPUT_SHAPE, debug: DEBUG, did: `called ${tool}`, fix: `call ${tool} with exactly one of brief or event`, tag: "ParamsRefused", why: `it got ${given.brief === undefined ? "neither" : "both"} a brief and an event` }))
    : Effect.succeed(given.event === undefined ? { docs: given.docs ?? {}, kind: "brief", text: given.brief ?? "" } : { data: given.event.data, kind: "event", name: given.event.name });

const decodeRequest = (tool: string, candidate: unknown) => {
  const decoded = Schema.decodeUnknownResult(PeonRequest, { errors: "all", onExcessProperty: "error" })(candidate);
  return Result.isFailure(decoded)
    ? Effect.fail(prompt({ accepted: RUN_SHAPE, debug: "read src/contract.ts PeonRequest in joelhooks/peons", did: `called ${tool}`, fix: `call ${tool}(${RUN_SHAPE})`, tag: "ParamsRefused", why: `the request does not decode as peons.request.v1: ${issuesOf(decoded.failure)}` }))
    : Effect.succeed(decoded.success);
};

const claimOutcome = (claimed: string | undefined, actual: string) => {
  if (claimed === undefined) {return "skip";}
  return claimed === actual ? "pass" : "fail";
};

const outcomeIcon = { fail: "❌", pass: "✅", skip: "➖" } as const;

const verdict = (name: string, actual: { sha256: string; bytes: number }, claimed: string | undefined): ToolOutput => {
  const check = Schema.decodeSync(Check)({ detail: `sha256 ${actual.sha256} · ${actual.bytes} bytes${claimed === undefined ? " · no claimed sha256 to compare" : ""}`, name, outcome: claimOutcome(claimed, actual.sha256) });
  return { data: { check, evidence: actual }, isError: check.outcome === "fail", text: `${outcomeIcon[check.outcome]} ${name}: ${check.detail}` };
};

const quoteDetail = (decoded: ReturnType<typeof decodeVerdict>, writes: string, verdictName: string, bad: readonly { readonly source: string }[], quotes: readonly unknown[]): string => {
  if (!decoded.ok) {return `the ${writes} doc is not a ${verdictName} verdict: ${decoded.why}`;}
  if (bad.length === 0) {return `${quotes.length} of ${quotes.length} quotes are exact substrings of the docs they cite`;}
  const where = bad.map((quote) => `${quote.source} #${quotes.indexOf(quote) + 1}`);
  return `${bad.length} of ${quotes.length} quotes are not exact substrings of the docs they cite: ${where.join(", ")}`;
};

const quoteCheckOf = (report: RunReport, writes: string, verdictName: keyof typeof verdicts, cites: Readonly<Record<string, string>>, doc: Schema.Json) => {
  const decoded = decodeVerdict(verdictName, doc);
  const docs = Object.fromEntries(Object.entries(cites).flatMap(([cited, held]) => (report.docs[held] === undefined ? [] : [[cited, docText(report.docs[held])]])));
  const quotes = decoded.ok ? quotesOf(decoded.verdict) : [];
  const bad = decoded.ok ? verifyQuotes(decoded.verdict, docs) : [];
  return Schema.decodeSync(Check)({
    detail: quoteDetail(decoded, writes, verdictName, bad, quotes),
    name: `verdict-quotes:${writes}`,
    outcome: decoded.ok && bad.length === 0 ? "pass" : "fail",
  });
};

const listing = (entry: { readonly runnable: boolean; readonly digest: string | null; readonly cellReady: boolean }): string => {
  if (entry.runnable) {return `runnable, digest ${entry.digest?.slice(0, 12) ?? "?"}`;}
  return entry.cellReady ? "no template yet" : "not cell-ready";
};

const decodeStored = (bytes: Uint8Array) => {
  try {
    const stored = decodeDefinedWorkflow(JSON.parse(Buffer.from(bytes).toString("utf-8")));
    return stored instanceof Prompt ? null : stored;
  } catch {
    return null;
  }
};

type Targeted = { readonly resolved: Resolved | null; readonly loaded: LoadedTemplate | null } | { readonly refused: ToolOutput };

// Which route or template a request names, or the refusal that says why none runs.
const targetOf = (catalog: Catalog, request: PeonRequest, templatesAccepted: string): Targeted => {
  const refusedAs = (template: string, route: FrozenStep["route"], refused: Prompt): Targeted => ({ refused: output(refusedRecord(request, template, route, refused)) });
  if (request.target.kind === "work-type") {
    const route = resolveRoute(catalog.routing, request.target.workType);
    if (route instanceof RouteRefused) {return refusedAs("unrouted", null, prompt({ accepted: route.accepted.join(", "), debug: "read routing.json in joelhooks/peons", did: "called peon_run", fix: 'call peon_run({ workType: "<one accepted concept>", brief })', tag: "RouteRefused", why: `work type ${JSON.stringify(route.workType)} has no route: ${route.reason}` }));}
    const {specialist} = route.route;
    if (!("peon" in specialist)) {return { loaded: null, resolved: route };}
    const loaded = findThink(catalog.think, specialist.peon) ?? null;
    if (loaded === null) {return refusedAs(specialist.peon.split("@")[0] ?? "unrouted", { concept: route.concept, specialist, status: route.route.status, tableVersion: route.tableVersion }, prompt({ accepted: templatesAccepted, debug: "read catalog.json and templates/ in joelhooks/peons", did: "called peon_run", fix: "call peon_catalog, then peon_run with a template it lists as runnable", tag: "TemplateRefused", why: `the route for ${route.concept} names ${specialist.peon}, which is not a cell-ready think template in this catalog` }));}
    return { loaded, resolved: route };
  }
  const wanted = `${request.target.template}${request.target.version === null ? "" : `@${request.target.version}`}`;
  const loaded = findThink(catalog.think, wanted) ?? null;
  if (loaded === null) {return refusedAs(request.target.template, null, prompt({ accepted: templatesAccepted, debug: "read catalog.json and templates/ in joelhooks/peons", did: "called peon_run", fix: 'call peon_run({ peon: "<one accepted template>", brief, docs })', tag: "TemplateRefused", why: `template ${wanted} is not a cell-ready think template in this catalog` }));}
  return { loaded, resolved: null };
};

export const makeTools = (deps: ToolDeps) => {
  const { catalog } = deps;
  const templatesAccepted = thinkNames(catalog.think).join(", ") || "none yet";

  const peon_catalog = (raw: unknown) =>
    params("peon_catalog", Schema.Struct({}), "{}")(raw ?? {}).pipe(
      Effect.map((): ToolOutput => {
        const runnable = new Set(thinkNames(catalog.think));
        const entries = catalog.entries.map((entry) => ({ cellReady: entry.cellReady, digest: findThink(catalog.think, nameOf(entry.template, entry.version))?.digest ?? null, kind: entry.kind, model: entry.model, needs: entry.needs, runnable: runnable.has(nameOf(entry.template, entry.version)), summary: entry.summary, template: entry.template, thinking: entry.thinking, version: entry.version }));
        const routes = Object.entries(catalog.routing.routes).map(([concept, route]) => ({ concept, specialist: route.specialist, status: route.status, why: route.why }));
        const lines = [
          `🪓 ${entries.length} catalog peons (${runnable.size} runnable), ${routes.length} routes (table v${catalog.routing.version}); outcome rates are unmeasured until outcome events land.`,
          ...entries.map((entry) => `- ${nameOf(entry.template, entry.version)} · ${entry.kind} · ${entry.model} ${entry.thinking} · ${listing(entry)}`),
          ...catalog.unlisted.map((tool) => `- ${nameOf(tool.template, tool.version)} · tool peon, not in catalog.json · ${tool.model} ${tool.thinking} · digest ${tool.digest.slice(0, 12)} · not run by peon_run`),
          ...routes.map((route) => `- ${route.concept} → ${"peon" in route.specialist ? route.specialist.peon : `${route.specialist.profile.model} ${route.specialist.profile.thinking}`} (${route.status})`),
          ...catalog.problems.map((problem) => `! ${problem}`),
        ];
        return {
          data: { concepts: Object.keys(catalog.routing.scheme.concepts).toSorted(), entries, outcomeRates: "unmeasured", problems: catalog.problems, routes, tableVersion: catalog.routing.version, unlisted: catalog.unlisted, workflow: { failurePolicies, gates, stepKinds } },
          isError: false,
          text: lines.join("\n"),
        };
      }),
      finish("peon_catalog"),
    );

  const swarmPath = (swarmId: string) => nodePath.join(deps.cwd, SWARM_DIR, `${swarmId}.json`);
  const storedSwarm = (swarmId: string) =>
    deps.files.read(swarmPath(swarmId)).pipe(
      Effect.map((bytes) => {
        if (bytes === null) {return null;}
        try {
          const decoded = Schema.decodeUnknownOption(SwarmManifest)(JSON.parse(Buffer.from(bytes).toString("utf-8")));
          return Option.isSome(decoded) ? decoded.value : "unreadable";
        } catch {
          return "unreadable";
        }
      }),
    );
  const recordSwarm = (swarmId: string, jobs: readonly (typeof SwarmJob.Type)[]) =>
    deps.files.write(swarmPath(swarmId), `${JSON.stringify({ jobs, schema: "peons.swarm.v2", swarmId }, null, 2)}\n`);

  const runOf = (tool: string, given: typeof RunParams.Type, desk: string, defaultRunId: (content: unknown) => string) =>
    Effect.gen(function* runOfGen() {
      if ((given.workType === undefined) === (given.peon === undefined))
        {return yield* prompt({ accepted: RUN_SHAPE, debug: DEBUG, did: `called ${tool}`, fix: `call ${tool} with exactly one of workType or peon, like { workType: "research", brief }`, tag: "ParamsRefused", why: `it got ${given.workType === undefined ? "neither" : "both"}` });}
      const input = yield* inputOf(tool, given);
      const [name, version] = (given.peon ?? "").split("@");
      const target = given.workType === undefined ? { kind: "template", template: name, version: version === undefined ? null : Number(version) } : { kind: "work-type", workType: given.workType };
      const content = { base: given.base ?? null, input, scope: given.scope ?? [], target };
      const runId = given.runId ?? defaultRunId(content);
      const request = yield* decodeRequest(tool, { desk, runId, schema: "peons.request.v1", ...content });
      const refusedAs = (template: string, route: FrozenStep["route"], refused: Prompt) => ({ refused: output(refusedRecord(request, template, route, refused)) });
      const targeted = targetOf(catalog, request, templatesAccepted);
      if ("refused" in targeted) {return { refused: targeted.refused };}
      const { loaded, resolved: routed } = targeted;
      const refusedName = loaded?.spec.template ?? routed?.concept.replaceAll("_", "-") ?? "unrouted";
      const resolved = onGateway(routed, loaded, given.model);
      if (resolved instanceof Prompt) {return refusedAs(refusedName, routeOf(routed), resolved);}
      const compiled = compileRun(request, resolved, loaded);
      if (compiled instanceof Prompt) {return refusedAs(refusedName, routeOf(resolved), compiled);}
      return { compiled, digest: sha256(canonical(content)), refusedName, request, route: compiled.frozen.steps[compiled.frozen.final]?.route ?? null };
    });

  const peon_run = (raw: unknown) =>
    Effect.gen(function* peonRunGen() {
      const given = yield* params("peon_run", RunParams, RUN_SHAPE)(raw);
      const desk = yield* deps.desk;
      const prepared = yield* runOf("peon_run", given, desk, (content) => `auto-${sha256(canonical(content)).slice(0, 24)}`);
      if ("refused" in prepared) {return prepared.refused;}
      const host = yield* deps.host;
      const result = yield* submitOnce(host, prepared.compiled, prepared.request, prepared.refusedName, prepared.route);
      return output(result, { mischiefRunId: prepared.compiled.runId });
    }).pipe(finish("peon_run"));

  const peon_swarm = (raw: unknown) =>
    Effect.gen(function* peonSwarmGen() {
      const given = yield* params("peon_swarm", SwarmParams, SWARM_SHAPE)(raw);
      const desk = yield* deps.desk;
      const swarmId = given.swarmId ?? `swarm-${sha256(canonical(given.jobs)).slice(0, 16)}`;
      const planned = given.jobs.map((job, index) => job.runId ?? `${swarmId}-${index}`);
      const repeated = planned.filter((runId, index) => planned.indexOf(runId) !== index);
      if (repeated.length > 0)
        {return yield* prompt({ accepted: "a distinct runId per job, or no runId so each defaults to <swarmId>-<index>", debug: DEBUG, did: `called peon_swarm with ${planned.length} jobs`, fix: "give each job its own runId, or drop runId from the jobs", tag: "SwarmRefused", why: `runId ${[...new Set(repeated)].join(", ")} names more than one job, so they would collapse into one run` });}
      const stored = yield* storedSwarm(swarmId);
      const sameJobs = (jobs: readonly (typeof SwarmJob.Type)[]) => stored !== null && stored !== "unreadable" && "jobs" in stored && canonical(stored.jobs) === canonical(jobs);
      const refuseReuse = () =>
        prompt({ accepted: "the same jobs as the first call with this swarmId, or a new swarmId", debug: `read ${nodePath.join(SWARM_DIR, `${swarmId}.json`)}`, did: `called peon_swarm with swarmId ${swarmId}`, fix: "call peon_swarm without swarmId, or with a new one", tag: "SwarmRefused", why: "an earlier swarm with this id holds different jobs (by run id or content digest), and reusing it would report its old results as answers to the new jobs" });
      const prepared = [];
      for (const [index, job] of given.jobs.entries()) {
        const one = yield* runOf("peon_swarm", job, desk, () => `${swarmId}-${index}`).pipe(Effect.result);
        prepared.push(one);
      }
      const refusals = prepared.flatMap((one, index) => {
        if (Result.isFailure(one)) {return [{ index, text: one.failure.message }];}
        return "refused" in one.success ? [{ index, text: one.success.refused.text }] : [];
      });
      if (refusals.length > 0)
        {return { data: { refused: refusals.map(({ index }) => index), swarmId }, isError: true, text: [`SwarmRefused: you called peon_swarm with ${given.jobs.length} jobs, and ${refusals.length} would not start, so none started`, ...refusals.map(({ index, text }) => `job ${index}: ${text.split("\n").join(" · ")}`), "Fix: correct each job above and call peon_swarm again with the same jobs; nothing was submitted.", `Debug: peon_catalog lists runnable peons and work-type routes; ${DEBUG}`].join("\n") };}
      const ready = prepared.flatMap((one) => (Result.isSuccess(one) && !("refused" in one.success) ? [one.success] : []));
      const jobs = ready.map((one) => ({ digest: one.digest, runId: one.request.runId }));
      if (stored !== null && !sameJobs(jobs)) {return yield* refuseReuse();}
      if (stored === null) {yield* recordSwarm(swarmId, jobs);}
      const host = yield* deps.host;
      const results = yield* Effect.forEach(ready, (one) => submitOnce(host, one.compiled, one.request, one.refusedName, one.route), { concurrency: 4 });
      const runIds = jobs.map(({ runId }) => runId);
      const lines = results.map((result, index) => `${index}. ${resultText(result).split("\n")[0] ?? ""}`);
      return { data: { results, runIds, swarmId }, isError: false, text: [`🪓 swarm ${swarmId} · ${results.length} peons`, ...lines, `Watch it with peon_status({ swarmId: "${swarmId}" }).`].join("\n") };
    }).pipe(finish("peon_swarm"));

  const inspected = (tool: string, runId: string) =>
    Effect.gen(function* inspectedGen() {
      const desk = yield* deps.desk;
      const host = yield* deps.host;
      const id = mischiefRunId(desk, runId);
      const report = yield* host.inspect(id).pipe(
        Effect.catchTag("UnknownRun", () =>
          Effect.fail(prompt({ accepted: "a runId this desk passed to peon_run or workflow_run", debug: `inspectRun({ runId: ${JSON.stringify(id)} })`, did: `called ${tool} for run ${JSON.stringify(runId)}`, fix: `call ${tool} with that runId, or start the run with peon_run`, tag: "UnknownRun", why: `${desk} has no such run on this Mischief host` })),
        ),
      );
      return { desk, host, id, report };
    });

  const swarmStatus = (swarmId: string) =>
    Effect.gen(function* swarmStatusGen() {
      const stored = yield* storedSwarm(swarmId);
      if (stored === null || stored === "unreadable")
        {return yield* prompt({ accepted: "a swarmId peon_swarm returned from this working directory", debug: `read ${nodePath.join(SWARM_DIR, `${swarmId}.json`)}`, did: `called peon_status for swarm ${swarmId}`, fix: "call peon_status with the swarmId peon_swarm printed, from the same desk directory", tag: "UnknownSwarm", why: stored === null ? "no swarm with that id was recorded here" : "its record does not decode" });}
      const desk = yield* deps.desk;
      const host = yield* deps.host;
      const runIds = swarmRunIds(stored);
      const results = yield* Effect.forEach(runIds, (runId) =>
        host.inspect(mischiefRunId(desk, runId)).pipe(
          Effect.map((report) => fromRunReport(report, { desk, runId })),
          Effect.catchTag("UnknownRun", () => Effect.succeed(null)),
        ), { concurrency: 4 });
      const counts: Record<string, number> = {};
      for (const result of results) {counts[swarmKind(result)] = (counts[swarmKind(result)] ?? 0) + 1;}
      const lines = results.map((result, index) => `${index}. ${result === null ? `missing · ${runIds[index] ?? ""}` : (resultText(result).split("\n")[0] ?? "")}`);
      return { data: { counts, results, swarmId }, isError: false, text: [`🪓 swarm ${swarmId} · ${Object.entries(counts).map(([name, count]) => `${count} ${name}`).join(" · ")}`, ...lines].join("\n") };
    });

  const peon_status = (raw: unknown) =>
    Effect.gen(function* peonStatusGen() {
      const asked = yield* params("peon_status", Schema.Union([Schema.Struct({ runId: NonEmpty }), Schema.Struct({ swarmId: NonEmpty })]), '{ runId: "<id>" } or { swarmId: "<id>" }')(raw);
      if ("swarmId" in asked) {return yield* swarmStatus(asked.swarmId);}
      const given = asked;
      const { desk, report } = yield* inspected("peon_status", given.runId);
      const result = fromRunReport(report, { desk, runId: given.runId });
      const docs = Object.fromEntries(Object.entries(report.docs).filter(([name]) => name !== FROZEN_DOC).map(([name, doc]) => [name, Buffer.byteLength(docText(doc), "utf-8")]));
      const status = { awaiting: (report.awaiting ?? []).map(({ messageId, to }) => ({ messageId, to })), docBytes: docs, failures: (report.failures ?? []).map(({ key }) => key), planVersion: report.planVersion, state: report.value, status: report.status, thinking: report.thinking?.line ?? null, transitions: report.transitions };
      const out = output(result, { run: status });
      return { ...out, text: `${out.text}\nMischief: ${report.status} at ${report.value ?? "no state"} · ${report.transitions} transitions${report.thinking === undefined ? "" : ` · ${report.thinking.line}`}` };
    }).pipe(finish("peon_status"));

  const peon_answer = (raw: unknown) =>
    Effect.gen(function* peonAnswerGen() {
      const given = yield* params("peon_answer", Schema.Struct({ answer: NonEmpty, messageId: NonEmpty, runId: NonEmpty }), '{ runId: "<id>", messageId: "<awaited message id>", answer: "<text>" }')(raw);
      const { desk, host, id, report } = yield* inspected("peon_answer", given.runId);
      const question = report.status === "waiting-for-joel" ? report.question : undefined;
      if (question !== undefined && given.messageId === escalationId(question)) {
        if (!question.options.includes(given.answer))
          {return yield* prompt({ accepted: question.options.join(", "), debug: `inspectRun({ runId: ${JSON.stringify(id)} })`, did: `answered escalation ${JSON.stringify(given.messageId)} on run ${JSON.stringify(given.runId)}`, fix: `call peon_answer({ runId: ${JSON.stringify(given.runId)}, messageId: ${JSON.stringify(given.messageId)}, answer: "<one of the choices>" })`, tag: "AnswerRefused", why: "the answer is not one of the escalation's choices" });}
        const answered = yield* host.answer(id, given.answer).pipe(
          Effect.catchTags({
            AnswerRefused: (refused) => Effect.fail(prompt({ accepted: question.options.join(", "), debug: `inspectRun({ runId: ${JSON.stringify(id)} })`, did: `answered escalation ${JSON.stringify(given.messageId)}`, fix: `call peon_status({ runId: ${JSON.stringify(given.runId)} })`, tag: "AnswerRefused", why: `Mischief refused the answer: ${refused.reason}` })),
            UnknownRun: () => Effect.fail(prompt({ accepted: "a runId this desk started", debug: `inspectRun({ runId: ${JSON.stringify(id)} })`, did: `answered escalation ${JSON.stringify(given.messageId)}`, fix: `call peon_status({ runId: ${JSON.stringify(given.runId)} })`, tag: "UnknownRun", why: "the run is gone from this Mischief host" })),
          }),
        );
        return output(fromRunReport(answered, { desk, runId: given.runId }));
      }
      const awaiting = report.status === "waiting-for-reply" ? (report.awaiting ?? []).map(({ messageId }) => messageId) : [];
      const open = [...awaiting, ...(question === undefined ? [] : [escalationId(question)])];
      if (!awaiting.includes(given.messageId))
        {return yield* prompt({
          accepted: open.length === 0 ? "none: answer only a run that peon_status reports blocked" : open.join(", "),
          debug: `inspectRun({ runId: ${JSON.stringify(id)} })`,
          did: `answered message ${JSON.stringify(given.messageId)} on run ${JSON.stringify(given.runId)}`,
          fix: `call peon_status({ runId: ${JSON.stringify(given.runId)} }) and answer the messageId its blocked record names`,
          tag: "AnswerRefused",
          why: `the run is ${report.status} and ${open.length === 0 ? "awaits no answer" : "awaits other messages"}`,
        });}
      const delivered = yield* host.deliver({ body: given.answer, replyTo: given.messageId, runId: id }).pipe(
        Effect.catchTag("ReplyRefused", (refused) =>
          Effect.fail(prompt({ accepted: awaiting.join(", "), debug: `inspectRun({ runId: ${JSON.stringify(id)} })`, did: `answered message ${JSON.stringify(given.messageId)}`, fix: `call peon_status({ runId: ${JSON.stringify(given.runId)} })`, tag: "AnswerRefused", why: `Mischief refused the reply: ${refused.reason}` })),
        ),
      );
      return output(fromRunReport(delivered, { desk, runId: given.runId }));
    }).pipe(finish("peon_answer"));

  const VERIFY_SHAPE = '{ runId: "<id>", sha256?: "<claimed>" } | { path: "<file>", sha256: "<claimed>" }';
  const peon_verify = (raw: unknown) =>
    Effect.gen(function* peonVerifyGen() {
      const given = yield* params("peon_verify", Schema.Struct({ commit: Schema.optionalKey(NonEmpty), path: Schema.optionalKey(NonEmpty), runId: Schema.optionalKey(NonEmpty), sha256: Schema.optionalKey(Schema.String) }), VERIFY_SHAPE)(raw);
      if (given.commit !== undefined)
        {return yield* prompt({ accepted: VERIFY_SHAPE, debug: DEBUG, did: "asked peon_verify to check a commit", fix: "call packet_verify for the commit, or peon_verify for a doc or file artifact", tag: "VerifyRefused", why: "commit artifacts need a checkout, base and dirty paths, which packet_verify owns" });}
      if (given.path !== undefined) {
        if (given.sha256 === undefined) {return yield* prompt({ accepted: VERIFY_SHAPE, debug: DEBUG, did: "asked peon_verify to check a file", fix: `call peon_verify({ path: ${JSON.stringify(given.path)}, sha256: "<the record's sha256>" })`, tag: "VerifyRefused", why: "it got no claimed sha256" });}
        const path = nodePath.isAbsolute(given.path) ? given.path : nodePath.join(deps.cwd, given.path);
        const bytes = yield* deps.files.read(path);
        if (bytes === null) {return yield* prompt({ accepted: "a readable file path", debug: DEBUG, did: `asked peon_verify to check ${given.path}`, fix: "call peon_verify with the artifact's path", tag: "VerifyRefused", why: "the file does not exist" });}
        return verdict("file-sha256", { bytes: bytes.byteLength, sha256: sha256(bytes) }, given.sha256);
      }
      if (given.runId === undefined) {return yield* prompt({ accepted: VERIFY_SHAPE, debug: DEBUG, did: "called peon_verify", fix: `call peon_verify(${VERIFY_SHAPE})`, tag: "VerifyRefused", why: "it got neither a runId nor a path" });}
      const { report, id } = yield* inspected("peon_verify", given.runId);
      const frozen = frozenOf(report);
      const doc = frozen === null ? undefined : report.docs[frozen.writes];
      if (frozen === null || doc === undefined)
        {return yield* prompt({ accepted: "a run whose record is peon.done", debug: `inspectRun({ runId: ${JSON.stringify(id)} })`, did: `asked peon_verify to check run ${JSON.stringify(given.runId)}`, fix: `call peon_status({ runId: ${JSON.stringify(given.runId)} }) until it is done`, tag: "VerifyRefused", why: frozen === null ? `the run has no ${FROZEN_DOC} doc` : `the run has not written ${frozen.writes} yet (it is ${report.status})` });}
      const text = docText(doc);
      const sha = verdict(`doc-sha256:${frozen.writes}`, { bytes: Buffer.byteLength(text, "utf-8"), sha256: sha256(text) }, given.sha256);
      const step = frozen.steps[frozen.final];
      if (step === undefined || step.verdict === null) {return sha;}
      // A think verdict: every quote must be an exact substring of the doc it cites. The check names
      // sources and positions, never the quotes, so no customer text leaves the run.
      const quoteCheck = quoteCheckOf(report, frozen.writes, step.verdict, step.cites, doc);
      const shaCheck = typeof sha.data === "object" && sha.data !== null && "check" in sha.data ? sha.data.check : null;
      const failed = sha.isError || quoteCheck.outcome === "fail";
      return { data: { checks: [shaCheck, quoteCheck].filter((check) => check !== null) }, isError: failed, text: `${sha.text}\n${outcomeIcon[quoteCheck.outcome]} ${quoteCheck.name}: ${quoteCheck.detail}` };
    }).pipe(finish("peon_verify"));

  const workflowPath = (id: string, version: number) => nodePath.join(deps.cwd, ".peons", "workflows", id, `v${version}.json`);

  const workflow_define = (raw: unknown) =>
    Effect.gen(function* workflowDefineGen() {
      const given = yield* params("workflow_define", Schema.Struct({ workflow: Schema.Unknown }), "{ workflow: <peons.workflow.v1 definition> }")(raw);
      const defined = defineWorkflow(given.workflow, catalog);
      if (defined instanceof Prompt) {return yield* defined;}
      const path = workflowPath(defined.definition.id, defined.definition.version);
      const existing = yield* deps.files.read(path);
      if (existing === null) {yield* deps.files.write(path, `${JSON.stringify(defined, null, 2)}\n`);} else {
        const stored = decodeStored(existing);
        if (stored === null || stored.digest !== defined.digest)
          {return yield* prompt({ accepted: `version ${defined.definition.version + 1} or later`, debug: `diff the definition against ${path}`, did: `defined workflow ${defined.definition.id} v${defined.definition.version}`, fix: `call workflow_define({ workflow }) with version: ${defined.definition.version + 1}`, tag: "WorkflowVersionTaken", why: `${path} already holds a different v${defined.definition.version}; versions never change once written` });}
      }
      const steps = Object.entries(defined.steps).map(([step, frozen]) => `- ${step}: ${frozen.template === null ? "no template" : nameOf(frozen.template.template, frozen.template.version)} · ${frozen.profile.model} ${frozen.profile.thinking}${frozen.route === null ? "" : ` (route ${frozen.route.concept}, ${frozen.route.status}, table v${frozen.route.tableVersion})`}`);
      return {
        data: { digest: defined.digest, path, planId: defined.plan.id, states: Object.keys(defined.plan.machine.states), steps: defined.steps },
        isError: false,
        text: [`📜 workflow ${defined.definition.id} v${defined.definition.version} ${existing === null ? "written" : "unchanged"} · ${path} · digest ${defined.digest.slice(0, 12)}`, ...steps, `Run it with workflow_run({ workflow: ${JSON.stringify(path)}, runId: "<id>", brief })`].join("\n"),
      };
    }).pipe(finish("workflow_define"));

  const WORKFLOW_RUN_SHAPE = `{ workflow: "<path workflow_define wrote>", runId: "<id>", ${INPUT_SHAPE} }`;
  const workflow_run = (raw: unknown) =>
    Effect.gen(function* workflowRunGen() {
      const given = yield* params("workflow_run", Schema.Struct({ runId: NonEmpty, workflow: NonEmpty, ...InputParams }), WORKFLOW_RUN_SHAPE)(raw);
      const desk = yield* deps.desk;
      const input = yield* inputOf("workflow_run", given);
      const request = yield* decodeRequest("workflow_run", { base: null, desk, input, runId: given.runId, schema: "peons.request.v1", scope: [], target: { kind: "template", template: "workflow", version: null } });
      const path = nodePath.isAbsolute(given.workflow) ? given.workflow : nodePath.join(deps.cwd, given.workflow);
      const bytes = yield* deps.files.read(path);
      if (bytes === null) {return yield* prompt({ accepted: "a path workflow_define returned", debug: DEBUG, did: `called workflow_run for ${given.workflow}`, fix: "call workflow_define({ workflow }) and pass the path it returns", tag: "WorkflowRunRefused", why: "no workflow doc is at that path" });}
      const parsed = yield* Effect.try({ catch: () => prompt({ accepted: "a path workflow_define returned", debug: DEBUG, did: `called workflow_run for ${given.workflow}`, fix: "call workflow_define({ workflow }) again", tag: "WorkflowRunRefused", why: "the workflow doc is not JSON" }), try: (): unknown => JSON.parse(Buffer.from(bytes).toString("utf-8")) });
      const defined = decodeDefinedWorkflow(parsed);
      if (defined instanceof Prompt) {return yield* defined;}
      const compiled = workflowRun(defined, { desk, input: request.input, runId: request.runId });
      if (compiled instanceof Prompt) {return yield* compiled;}
      const host = yield* deps.host;
      const result = yield* submitOnce(host, compiled, request, defined.definition.id, null);
      return output(result, { mischiefRunId: compiled.runId, workflow: { digest: defined.digest, id: defined.definition.id, version: defined.definition.version } });
    }).pipe(finish("workflow_run"));

  return { peon_answer, peon_catalog, peon_run, peon_status, peon_swarm, peon_verify, workflow_define, workflow_run };
};
