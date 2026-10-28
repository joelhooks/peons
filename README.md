# peons

Cheap agents on celld. A **peon** is any cheap pi-durable agent running on celld. A peon **can** be made from a template, and this repo holds the templates. A **template** is warmed once with everything a job needs, frozen at its ready point, and forked per request, so each fork starts warm. A templated peon is one fork: one request in, one artifact out. Other peons are started cold or kept running, without a template.

Arrows (`templates/arrows-svg/v1`) is peon #1, a templated one: one themed request in, one Quiver Arrow 2 SVG out.

## Rules

- **Schema first, DDD.** Every value that crosses a boundary has an Effect Schema, and is decoded where it enters: jobs, ledger lines, provider replies and templates. There are no `as T` casts on untrusted input. Domain words are `template`, `peon`, `ready point`, `digest`, `artifact`, `refusal` and `ledger`.
- **Pure decisions, effectful edges.** Spend, artifacts and theming are pure functions over values. `bin/` holds composition roots that read facts, ask the decisions, do the IO and append what happened.
- **Facts, not state.** The spend ledger is append-only. "Calls used" is a projection of it.
- **Refuse before spending.** Anything that can refuse (the model, the references) is checked before a call is reserved.
- **Arrow 2 or later only.** The client refuses older Arrow models.
- **Content is identity.** A template's digest is its identity. `name@version` is a pointer that moves.

## Boundaries

| Context | Owns | Does not own |
|---|---|---|
| **peons** (this repo) | Template specs, warm context, tool code, the canonical template-node schema | Running agents, mail |
| **Mischief** (`pi-durable/desk`) | Template lifecycle (warm, freeze, revalidate), forks, runs, the prefix digest | Addresses, catalog content |
| **Rat King** (`rats-nest/rats-nest-desk`) | Names, keys, sub-addresses and routes with a TTL, delivery | What a peon or sidecar *is* |
| **agent-graph** (`agent-graph/desk`) | Graph records and learning which template works | Template content |
| **Muster** | v0 only: forking a warmed Pi on one Mac | The long-term runtime |

## Use

```sh
pnpm install
pnpm test
node bin/digest.ts templates/arrows-svg/v1          # the template's digest
node bin/arrow.ts generate job.json --out runs/x     # one paid Quiver call
node bin/peon-compile.ts templates/change-review/v1 request.json > body.json   # a think peon's submitPlan body, or its refusal
```

Think peons (`change-review`, `investigation`) are one Mischief think each: the template's rules are seeded as a doc, the caller's docs are checked against the template's declared inputs, and the verdict comes back as one JSON doc. `compile` refuses before anything is spent (`MissingInput`, `UnknownInput`, `InputTooLarge`, `EventNotAccepted`, `TemplateMismatch`). The catalog of generic peons is `catalog.json`.

`bin/arrow.ts` leases `quiver_api_key` from agent-secrets and enforces a call cap (`PEON_QUIVER_CALL_CAP`, default 10, set by Joel) from `~/.local/state/peons/quiver-ledger.jsonl`.

### The Pi extension

The `pi` key loads `extensions/pi`. A desk runs a peon in one call, or builds a workflow from peon steps, on a Mischief host. Every tool refuses with a 4-line prompt (`Tag`, `Accepted`, `Fix`, `Debug`). No tool sends mail, archives, pushes, deploys or starts a timer. To wait on a run, watch `peon_status`.

| Tool | What it does |
|---|---|
| `peon_catalog` | Lists the `catalog.json` peons (kind, model, cell-ready, and whether a think template makes them runnable, with its digest), tool peons outside the catalog (`arrows-svg`), and the work-type routes from `routing.json`. |
| `peon_run` | `{ workType }` or `{ peon: "<template>@<version>" }`, with a `brief` (plus optional `docs`) or an `event`, and optional `base`, `scope` and `runId`. A `{profile}` route compiles here as one think step; a `{peon}` route or template target compiles through `src/think-template.ts`, and its body must decode as a Mischief submission (no `version`: Mischief stamps it). The route is frozen in, then the run is submitted. A think run is `peon.done` only when its verdict doc decodes with the template's verdict schema. A submit 422 comes back as `peon.refused` with Mischief's errors. Idempotent on `runId`: an existing run returns its record. With no `runId`, it uses a digest of the request. |
| `peon_status` | A run's record (`running`, `peon.done`, `peon.blocked`, `peon.failed`, `peon.refused`), its Mischief state and its doc sizes. It never returns doc contents. |
| `peon_answer` | `{ runId, messageId, answer }`. An ask's reply goes to `deliverReply`; a judge escalation (`announce:<key>#<n>`, choices in the blocked record) goes to `answerRun` with one of its choices. Nothing is sent unless the run awaits exactly that message. |
| `peon_verify` | Checks a run's artifact doc, or a file by `path`, against a claimed `sha256`. A think verdict also runs `verifyQuotes`: every quote must be an exact substring of the doc it cites. Failures name sources and positions, never quotes. Commits go to `packet_verify`. |
| `workflow_define` | Compiles a `peons.workflow.v1` definition into one Mischief plan and writes `.peons/workflows/<id>/v<version>.json`. A step is `{ id, kind: "peon", template \| workType, input: { text, from?, docs? }, gate?: "verify" \| "owner-approve", check?, failurePolicy?: "stop" }`. A `{profile}` step lists what it reads in `from`; a templated step maps each declared template input to `"input"` or an earlier step id in `docs`, and its docs are renamed per step so two steps on one template never collide. Routes freeze at define time. A version, once written, never changes. |
| `workflow_run` | `{ workflow: <path>, runId, brief \| event }`. Submits the stored plan as one run, idempotent on `runId`. Answer an owner-approve gate with `peon_answer`. |

`workflow_define` also accepts [composed v2 workflows](docs/workflow-v2.md): peon and digest-pinned v1 workflow leaves, maps over batches, and code-only gather. V2 `workflow_run` omits `runId`; it reconciles observed attempts, writes a manifest before submitting, and starts only missing attempts. Re-call after leaves settle. Input digests and bound profiles join each attempt id, and failures stop retrying at the attempt cap (default 2). `peon_swarm` is unchanged.

The run tools need three environment variables:

- `MISCHIEF_HOST`: the worker origin, like `http://host:port/`.
- `PEONS_IDENTITY_SECRET`: the agent-secrets name of the desk's Rat King identity. Every call is signed with that identity's DID.
- `PEONS_DESK`: the desk's Rat King name. When it's unset, the tools fall back to `RATKING_NAME`.

`MISCHIEF_AUDIENCE` overrides the default worker audience. `retry-once-on:<tag>` is refused until Mischief can route a step failure by tag.

`pnpm check:pi` type-checks `extensions/` against the installed Pi (`PI_CODING_AGENT_DIR`, else the `pi` launcher on PATH, else npm's global root). The gate is `tsc -p . && pnpm test && pnpm check:pi`.

## Layout

```
src/template-node.ts      canonical template-node schema (moved from agent-graph-desk)
src/quiver.ts             Quiver REST client: prepare (can refuse) and send (paid)
src/spend.ts              ledger schema and the spend decision
src/artifact.ts           ArrowArtifact values
src/themify.ts            light and dark post-step (from Piper's pipeline)
bin/arrow.ts              the peon's paid tool
bin/digest.ts             template digest
src/contract.ts           the one peon contract: request, queue records, artifacts, catalog
src/think-template.ts     think templates: load, digest, compile to one Mischief think
src/verdicts.ts           output schemas for think peons
bin/peon-compile.ts       request in, submitPlan body or refusal out
catalog.json              ranked generic peons (peons.catalog.v1)
src/compile.ts            {profile} route → one-think Mischief plan; workflows; the derived Mischief plan schema and checks
src/run-report.ts         Mischief run report → contract handle or record
src/workflow.ts           v1 workflow definition → one Mischief plan
src/workflow-v2.ts        composed workflows → pure reconcile, map/gather, attempt ids
extensions/pi/            the Pi tools, the run-host port, the live signed adapter and check:pi
templates/<name>/v<n>/    template.json, warmup/, references/
```
