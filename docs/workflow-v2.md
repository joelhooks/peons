# Composed workflows (slice 1)

`peons.workflow.v2` schedules existing peon plans and defined v1 workflows. It does not add a Mischief step kind. A v1 workflow leaf remains **one plan**, including its verify and owner-approve states. `peon_swarm` is unchanged.

## Define

Call `workflow_define({ workflow })`. Routes, template versions, profiles, seed docs and leaf plans freeze in the definition. The result includes a content-addressed `path` under `.peons/workflows/by-digest/` and a versioned alias. A version cannot be replaced with different content.

```ts
const workflow = {
  schema: "peons.workflow.v2",
  id: "review-batches",
  version: 1,
  desk: "example/desk",
  retryCap: 2, // total attempts, not additional retries; default 2
  steps: [
    {
      id: "review",
      kind: "map",
      over: { from: "input.batches" },
      task: {
        kind: "peon",
        workType: "review", // a concept in the caller's routing table
        input: {
          text: 'Review each item. Return {"items":[{"id":"...","verdict":...}]} as JSON.',
          docs: { subject: { from: "batch" } },
        },
      },
    },
    { id: "collect", kind: "gather", from: "review", writes: "verdicts" },
  ],
};
```

Use a work type whose output follows the batch verdict contract. A template with a different verdict schema is not a batch-review template. A done map attempt with malformed output or missing, duplicate or foreign item ids counts as failed. Reconcile retries it under the attempt cap and ends the leaf failed at the cap. Gather repeats the same decoder as a final guard rather than guessing.

Step kinds:

- `peon`: exactly one of `template: "name@version"` or `workType: "concept"`, and `input: { text, docs }`. Template inputs must match the template declarations. Byte limits still apply to actual runtime docs.
- `workflow`: `workflow: <the complete peons.workflow-plan.v1 doc written by workflow_define>`, and `input: { text, docs }`. Its digest is checked at definition time and the compiled plan freezes in the v2 definition. Read the v1 file and embed its JSON, not a path. No lookup of a mutable workflow name occurs at runtime.
- `map`: `over: { from: "step.doc" }`, and `task: <peon or workflow without an id>`. Its list contains batches, not individual items. Each batch is an array of objects with distinct nonempty string `id` fields. Item ids must also be distinct across batches. Additional item fields survive unchanged. Each map allows 0–64 batches. An empty map settles immediately.
- `gather`: `from: "earlier-map-id"`, `writes: "doc-name"`. Runs as code with no submit. Each successful leaf must return JSON `{ items: [{ id, verdict }] }`, where `verdict` is a JSON value. Gather checks the ids against that leaf's batch exactly once, with no duplicates, omissions or foreign ids.

Named inputs use `{ from: "<earlier-step>.<output-doc>" }`. External docs use `input.<name>`; `input.brief` is the brief text. A map task can read its batch with `{ from: "batch" }`. References must name an earlier step's actual output doc. Profile peons write `artifact`; templates write their declared doc; v1 workflow leaves write their final step's doc. A map's named output is the array of leaf output docs. Gather writes its declared doc.

A v2 composition can contain peons and v1 workflow leaves, not another v2 composition. V2-in-v2 nesting belongs to slice 2 together with bundles.

A v1 workflow receives its selected docs as `{ text, docs }` in its existing `peon-input` doc, exactly as v1 `workflow_run` does. It is not flattened into v2 steps. To chain a gather into a v1 workflow, add a `workflow` step with an input such as `docs: { verdicts: { from: "collect.verdicts" } }`.

## Run and reconcile

```ts
workflow_run({
  workflow: "<content-addressed path from workflow_define>",
  brief: "Review these batches",
  docs: { batches: JSON.stringify([[{ id: "one", text: "..." }]]) },
});
```

Omit `runId` for v2. Re-call with the same definition and inputs after leaves settle. No peons timer, watcher or local scheduler starts.

The core API is pure:

```ts
reconcile(definedComposition, {
  input: { batches: [[{ id: "one", text: "..." }]] },
  runs: { /* actual Mischief run id -> observed RunReport */ },
});
```

The result contains `abort`, `submit`, `inspect`, leaf and step states, named `docs`, and an overall `status`. Each abort intent contains `runId`, `supersededBy` (the next attempt id when under the cap), and `reason`. Missing inputs, invalid plans and malformed gather output return the standard four-line refusal. Reconcile never changes its arguments or performs I/O.

Lifecycle:

```text
waiting -> missing -> active -> done
                         | terminal failure
                         v
                    next attempt -> active
                         | attempt cap
                         v
                       failed -> dependent steps failed

active -> stuck / envelope-exceeded -> aborting -> observed aborted
                                                    | under cap: next attempt
                                                    | at cap: failed
```

An absent leaf starts at `a1`. A done map attempt whose verdict fails JSON decoding or batch 1:1 membership also follows the failure transition; a missing item cannot leave the composition refusing forever. Terminal `failed`, `aborted` and `amendment-refused` attempts advance to `a(n+1)` while `n < retryCap`. A v1 workflow ending in `rejected` also counts as failed. A done run with an invalid verdict is terminal too, so these cases need no abort.

`stuck` and `envelope-exceeded` are resumable halts, not terminal failures. Reconcile returns an abort intent and keeps the leaf `aborting`; it never returns that leaf's replacement in the same reconciliation. The adapter calls `abortRun` with `supersededBy: <next attempt id>` before that replacement can start. Only a later reconciliation observing a terminal report can advance. At the cap, it aborts the halted attempt without naming a nonexistent replacement, then marks the leaf failed once the abort is observed. Terminal aborts are idempotent; the fake and live adapters match Mischief's contract.

`running`, `paused`, `waiting-for-reply`, `waiting-for-joel` and `waiting-for-provider` are active and never trigger a retry or abort. In particular, Mischief resumes `waiting-for-provider` itself after an outage. Active and blocked attempts never resubmit. At the cap, a terminal failed leaf stays failed and reconcile returns no submission for it. Independent ready leaves can still proceed when another branch fails.

Each attempt id hashes the definition digest, step path, selected input digests (including the batch), and all bound profiles. The desk-scoped `mischiefRunId` is suffixed with `-a<n>`. The actual host id stays within 64 lowercase letters, digits and hyphens. Changed input cannot reuse a previous verdict. Each attempt's frozen record contains its bound profiles.

The Pi adapter inspects the ids reconcile derives, repeats discovery when settled inputs expose more leaves, validates every ready leaf, writes a content-addressed manifest, then executes abort intents before submitting missing attempts, with concurrency 4 for each phase. It does not submit a halted leaf's replacement until a subsequent call observes the abort. The manifest records both abort intents and submissions. A crash after some submissions needs no local cursor: the next call discovers the host records and submits only the remaining attempts. Manifests are immutable receipts under `.peons/workflow-runs/`, not progress state. The host's idempotent submit handles concurrent callers racing on the same absent run. Peons cannot guarantee that two simultaneous callers never invoke submit for the same absent id; the sequential crash/retry property guarantees no resubmission once the host record is observable.

Gather returns per-item verdicts (including their proof fields) and per-leaf usage for **all attempts**, including failed attempts. Each leaf and attempt has `costUsd`; the gather doc has `totalCostUsd`. `costBasis: "list-price-equivalent"` labels these estimates, not invoices. `cost` remains a compatibility alias of `costUsd`.

Peons calculates cost from the attempt's frozen profile model and `thinking.tokens`, not host-reported `listCostUsd`. The standard-tier price table in `src/list-cost.ts` was checked on 2026-10-12: Opus input/output/cache-read/cache-write cost $4/$20/$0.20/$5 per million tokens; Sol costs $2/$10/$0.10/$2.50. Luna and unknown or mixed models return `null` with `costReason`, never zero. A total containing an unknown attempt is also `null`.

`cacheWrite` is optional on incoming receipts. Older hosts omit it; peons derives it from the exact total in `thinking.line` (`… · N tok …`) minus input, output and cache-read tokens. Missing or inconsistent totals keep cost unknown rather than silently dropping paid cache writes. Explicit `cacheWrite: 0` is known usage. Unavailable usage stays `null` in gather.

V2 results expose actual host run ids. Re-call `workflow_run` to observe and advance the composition. `peon_status` and `peon_answer` also accept these v2 leaf ids directly, after checking that the frozen record belongs to the current desk. Existing v1 logical ids keep their previous behavior.

## Verification

`test/workflow-v2.test.ts` runs three generated properties against `fakeHost()`: 100 nested workflow/crash/retry/input-replay schedules, 100 mixed per-leaf failure schedules, and 100 omitted-item verdict schedules that recover below the cap or end failed at the cap without refusing. It also covers partial submission recovery, manifest-before-submit ordering, input limits, 64-leaf bounds, exact gather membership, all-attempt usage, gate answers, invalid template verdicts and empty maps. `test/workflow-abort.test.ts` adds a 100-case generated resume/crash/abort property: at most one non-terminal attempt per leaf at every transition, with eventual convergence or cap failure. It resumes halted runs between observation and abort, tests every active/wait status (including provider waits), terminal abort idempotency, manifest-before-abort ordering, and cancellation at the cap. No live host submits or aborts are part of these tests.

Mutation receipts from scratch copies, using `vitest run test/workflow-v2.test.ts --maxWorkers=4 -t 'generated nested workflows'`:

- **Plant A:** replaced the identity's `inputDigests` with `null`. The property failed (exit 1), shrinking to one batch, one nested step, cap 1 and no failures. Changing the input reused the old verdict instead of starting a new attempt.
- **Plant B:** changed the failed-attempt branch to return that same attempt as missing. The property failed (exit 1) with `Error: duplicate attempt`; retries could not converge without resubmitting an existing id.
- Reverted both plants in their scratch copies. The same property then passed in each copy (exit 0), and both restored sources matched the working source byte-for-byte. Neither mutation was applied to the working checkout.
- **Follow-up plant C:** removed the map-verdict check from `settleLeaf`, leaving validation in gather only. The generated omitted-item verdict property failed with exit 1 on the old permanent-refusal path. Restoring the check made the same property pass. This proves that gather-only validation does not satisfy retry liveness.
- **Follow-up plant D:** disabled abort intents and counted `stuck`/`envelope-exceeded` as terminal failures again. `vitest run test/workflow-abort.test.ts --maxWorkers=4 -t 'generated resume/crash/abort schedules'` failed with exit 1 and `Error: two live attempts for one leaf`. Restored the abort barrier; the same property passed (exit 0), and the restored source matched the working source byte-for-byte. The mutation stayed in a scratch copy.

Leaf deadlines for `paused` or `waiting-for-joel` runs are a later item; this slice does not timeout or cancel them. Bundles, imports, portable model binding, extra host adapters and `peon_swarm` sugar are outside this slice.
