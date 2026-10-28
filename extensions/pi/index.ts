// peons for Pi: run a peon in one call, or build a workflow from peon steps, on a Mischief host.
// The TypeBox parameters only describe the tools to the model; tools.ts decodes every argument with
// Effect Schema. Nothing starts at load: the catalog loads on first use, and the live host leases
// the desk identity on the first call that needs it.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Cause, Effect, Exit, Schema } from "effect";
import { Type } from "typebox";

import { PeonRequest } from "../../src/contract.ts";
import { Prompt, prompt } from "../../src/compile.ts";
import { loadCatalog } from "./catalog.ts";
import type { Catalog } from "./catalog.ts";
import { leasedSigner, liveEnv, liveRunHost } from "./live-host.ts";
import type { RunHostPort } from "./host.ts";
import { makeTools } from "./tools.ts";
import type { Files, ToolOutput } from "./tools.ts";

const Input = {
  brief: Type.Optional(Type.String({ description: "The request in plain words. Never include secrets." })),
  docs: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Named docs for the brief, by slug. A think template takes exactly its declared inputs; peon_catalog lists them" })),
  event: Type.Optional(Type.Object({ data: Type.Unknown(), name: Type.String() }, { description: "An event instead of a brief" })),
};

const RunJob = Type.Object({
  peon: Type.Optional(Type.String({ description: "A runnable catalog template, like change-review@1" })),
  workType: Type.Optional(Type.String({ description: "A work-type concept, like research or bugfix" })),
  ...Input,
  base: Type.Optional(Type.Object({ repo: Type.String(), sha: Type.String() })),
  model: Type.Optional(Type.Union([Type.Literal("sol"), Type.Literal("luna"), Type.Literal("opus")], { description: "Override the route's model on a workType job" })),
  runId: Type.Optional(Type.String({ description: "Idempotency key. Default: a digest of the request" })),
  scope: Type.Optional(Type.Array(Type.String())),
});

const PEON_TOOLS = ["peon_catalog", "peon_run", "peon_swarm", "peon_status", "peon_answer", "peon_verify", "workflow_define", "workflow_run"];

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEBUG = "read extensions/pi/index.ts in joelhooks/peons";

const files: Files = {
  read: (path) =>
    Effect.tryPromise({
      catch: () => prompt({ accepted: "a readable path", debug: DEBUG, did: `read ${path}`, fix: "check the path and its permissions", tag: "FileUnreadable", why: "the file system refused it" }),
      try: async (): Promise<Uint8Array | null> => {
        try {
          return await readFile(path);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {return null;}
          throw error;
        }
      },
    }),
  write: (path, text) =>
    Effect.tryPromise({
      catch: () => prompt({ accepted: "a new path under the working directory", debug: DEBUG, did: `wrote ${path}`, fix: "call workflow_define again; an existing version is compared, not overwritten", tag: "FileUnwritable", why: "the file system refused it, or the file appeared meanwhile" }),
      try: async () => {
        await mkdir(nodePath.dirname(path), { recursive: true });
        await writeFile(path, text, { flag: "wx" });
      },
    }),
};

const deskName = (env: NodeJS.ProcessEnv): Effect.Effect<string, Prompt> => {
  const name = env.PEONS_DESK ?? (env.RATKING_NAME === "off" ? undefined : env.RATKING_NAME);
  return name !== undefined && Schema.is(PeonRequest.fields.desk)(name)
    ? Effect.succeed(name)
    : Effect.fail(prompt({ accepted: "PEONS_DESK=<this desk's Rat King name, like agent-graph/desk>", debug: DEBUG, did: "called a peons tool that addresses a desk", fix: "export PEONS_DESK in the desk's environment, /reload, then call the tool again", tag: "DeskUnset", why: name === undefined ? "neither PEONS_DESK nor RATKING_NAME is set" : "PEONS_DESK is not a Rat King desk name" }));
};

export default function peons(pi: ExtensionAPI) {
  let catalog: Promise<Catalog> | null = null;
  let host: RunHostPort | null = null;
  const tools = (cwd: string, tool: string) =>
    Effect.gen(function* toolsGen() {
      catalog ??= Effect.runPromise(loadCatalog(ROOT));
      const loaded = yield* Effect.tryPromise({ catch: () => prompt({ accepted: "a peons checkout whose pnpm test passes", debug: DEBUG, did: "loaded the peons catalog", fix: "run pnpm test in joelhooks/peons, fix what fails, then /reload", tag: "CatalogUnreadable", why: "routing.json, catalog.json or templates/ did not decode" }), try: async () => await (catalog ?? Promise.reject(new Error("unloaded"))) });
      const hostEffect = Effect.suspend((): Effect.Effect<RunHostPort, Prompt> => {
        if (host !== null) {return Effect.succeed(host);}
        const env = liveEnv(process.env, tool);
        if (env instanceof Prompt) {return Effect.fail(env);}
        host = liveRunHost({ audience: env.audience, endpoint: env.endpoint, fetch, signer: leasedSigner(env.secretName) });
        return Effect.succeed(host);
      });
      return makeTools({ catalog: loaded, cwd, desk: deskName(process.env), files, host: hostEffect });
    });

  const execute = (name: keyof ReturnType<typeof makeTools>) => async (_id: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { readonly cwd: string }) => {
    const exit = await Effect.runPromiseExit(
      tools(ctx.cwd, name).pipe(
        Effect.flatMap((made) => made[name](params)),
        Effect.catchTag("Prompt", (refused) => Effect.succeed<ToolOutput>({ data: { tag: refused.tag }, isError: true, text: refused.message })),
      ),
    );
    const out: ToolOutput = Exit.isSuccess(exit) ? exit.value : { data: { tag: "PeonsDefect" }, isError: true, text: `PeonsDefect: you called ${name}, and it failed because of an unexpected defect\nAccepted: a call the tool handles\nFix: report this to agent-graph/desk with the tool name and time\nDebug: ${Cause.pretty(exit.cause).split("\n")[0] ?? "no cause"}` };
    return { content: [{ text: out.text, type: "text" as const }], details: out.data, isError: out.isError };
  };


  pi.registerTool({
    annotations: { openWorldHint: false, readOnlyHint: true },
    description: "List the catalog peons (catalog.json: kind, model, cell-ready, runnable and digest), tool peons outside the catalog, and the work-type routes, with workflow step kinds, gates and failure policies.",
    execute: execute("peon_catalog"),
    label: "Peon catalog",
    name: "peon_catalog",
    parameters: Type.Object({}),
    promptSnippet: "peon_catalog: list catalog peons and work-type routes",
  });
  pi.registerTool({
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false },
    description: "Run one peon on Mischief: { workType } or { peon: template@version }, with a brief (and the template's input docs) or an event. A think template compiles through think-template.ts and its verdict is decoded before the run counts as done. Returns a handle or a record at once. Idempotent on runId: the same runId returns the existing run. Watch it with peon_status.",
    execute: execute("peon_run"),
    label: "Peon run",
    name: "peon_run",
    parameters: RunJob,
    promptSnippet: "peon_run: run a cheap peon for a work type or template, idempotent on runId",
  });
  pi.registerTool({
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false },
    description: "Start up to 64 peons at once, each job shaped like peon_run. Every job is checked first; if any is refused, none starts and each refusal is listed. Run ids are <swarmId>-<index>, so calling again with the same jobs starts nothing twice. Watch with peon_status({ swarmId }).",
    execute: execute("peon_swarm"),
    label: "Peon swarm",
    name: "peon_swarm",
    parameters: Type.Object({
      jobs: Type.Array(RunJob, { maxItems: 64, minItems: 1 }),
      swarmId: Type.Optional(Type.String({ description: "Lowercase id, like drovr-dead-code-a. Default: a digest of the jobs" })),
    }),
    promptSnippet: "peon_swarm: start many peons all-or-none, then watch peon_status({ swarmId })",
  });
  pi.registerTool({
    annotations: { openWorldHint: true, readOnlyHint: true },
    description: "Inspect a peon or workflow run: its record (running, done, blocked, failed, refused), Mischief state, transitions, token line and doc sizes. Never doc contents.",
    execute: execute("peon_status"),
    label: "Peon status",
    name: "peon_status",
    parameters: Type.Union([Type.Object({ runId: Type.String() }), Type.Object({ swarmId: Type.String() })]),
  });
  pi.registerTool({
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
    description: "Answer a blocked run by runId and messageId: an ask's reply as free text, or a judge escalation with one of its choices. Refused unless the run is awaiting exactly that message.",
    execute: execute("peon_answer"),
    label: "Peon answer",
    name: "peon_answer",
    parameters: Type.Object({ answer: Type.String(), messageId: Type.String(), runId: Type.String() }),
  });
  pi.registerTool({
    annotations: { openWorldHint: true, readOnlyHint: true },
    description: "Check an artifact against evidence: a run's artifact doc, or a file by path, against a claimed sha256. A think verdict also gets verifyQuotes: every quote must be an exact substring of the doc it cites. Commits go to packet_verify.",
    execute: execute("peon_verify"),
    label: "Peon verify",
    name: "peon_verify",
    parameters: Type.Object({ commit: Type.Optional(Type.String()), path: Type.Optional(Type.String()), runId: Type.Optional(Type.String()), sha256: Type.Optional(Type.String()) }),
  });
  pi.registerTool({
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: false },
    description:
      'Compile a workflow of peon steps into one Mischief plan and write it as a versioned doc under .peons/workflows/<id>/v<version>.json. Definition: { schema: "peons.workflow.v1", id, version, desk, steps: [{ id, kind: "peon", template | workType, input: { text, from?: ["input" | earlier step id] for a {profile} step, docs?: { <template input>: "input" | earlier step id } for a templated step }, gate?: "verify" | "owner-approve", check?, failurePolicy?: "stop" }] }. Routes freeze now. Also accepts peons.workflow.v2 compositions with peon, digest-pinned v1 workflow, map and gather steps; see docs/workflow-v2.md. V2 writes a content-addressed definition.',
    execute: execute("workflow_define"),
    label: "Workflow define",
    name: "workflow_define",
    parameters: Type.Object({ workflow: Type.Unknown({ description: "A peons.workflow.v1 or peons.workflow.v2 definition" }) }),
  });
  pi.registerTool({
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false },
    description: "V1: submit one Mischief plan, idempotent on runId; watch with peon_status. V2: omit runId; reconcile the composition, submit only missing attempts, and re-call with identical input after leaves settle. Each v1 workflow leaf stays one plan with its gates intact. V2 writes a manifest before aborting resumable halts or submitting attempts. A replacement starts only after the old attempt is terminal; provider waits stay active. No background watcher starts.",
    execute: execute("workflow_run"),
    label: "Workflow run",
    name: "workflow_run",
    parameters: Type.Object({ runId: Type.Optional(Type.String({ description: "Required for v1; omit for v2 (attempt ids are content-derived)" })), workflow: Type.String({ description: "The path workflow_define returned" }), ...Input }),
  });

  pi.on("session_start", () => {
    const active: readonly string[] = pi.getActiveTools();
    const on = new Set<string>(active);
    const inactive = PEON_TOOLS.filter((name) => !on.has(name));
    if (inactive.length > 0) {
      pi.setActiveTools([...active, ...inactive]);
    }
  });
}
