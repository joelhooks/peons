# Box swarm

Run one test case per Mischief box. From the repo root, with Node 24+, dependencies installed, and the peons desk's Rat King identity available through agent-secrets:

```sh
MISCHIEF_HOST=<worker-origin> node scripts/box-swarm/cli.ts smoke-01 matrix.json
```

Add `--destroy` only if Mischief may discard each finished box's workspace. By default the runner leaves the boxes to Mischief's normal lifecycle. The worker origin must be the approved origin for the desk; the runner uses the existing desk signer. `MISCHIEF_AUDIENCE` overrides the default token audience.

## Three-cell matrix

Replace the example SHA with the full commit SHA to test. Use lowercase letters, digits and hyphens for the swarm ID. Cell IDs must be unique and use lowercase letters and digits only: the final hyphen in `<swarmId>-<cellId>` separates the two IDs. Keep the combined ID to 40 characters or fewer.

```json
{
  "template": "full@1",
  "model": "sol",
  "workspace": {
    "repo": "joelhooks/peons",
    "sha": "0123456789012345678901234567890123456789"
  },
  "concurrency": 2,
  "turnBudget": 2,
  "cells": [
    { "id": "check", "brief": "In /work, install the pinned dependencies and run pnpm check." },
    { "id": "test", "brief": "In /work, install the pinned dependencies.", "turns": ["Run pnpm test and report whether it passed."] },
    { "id": "lint", "brief": "In /work, install the pinned dependencies and run pnpm lint." }
  ]
}
```

`brief` is the first prompt. Each `turns` entry is one later prompt in the same box. `turnBudget` caps the total prompts per cell, including `brief`; the runner rejects an over-budget matrix before spawning. The runner adds the output contract to the last prompt: a single final JSON line with `cell`, boolean `pass`, optional `failedStep`, string `notes`, and an `evidence` array. Use `[]` for no evidence. Each item has `name`, `mime`, and canonical padded `base64`. Keep names unique ignoring case and use at most four files, each at most 300,000 decoded bytes.

The default is eight concurrent cells for `full@1` and six for `browser@1`. Use `browser@1` only once the worker exposes that template. A coded `CapacityFull` 429 from spawn waits with backoff (1s up to 30s). `capacityWaitMs` caps that wait per cell (default 30 minutes; `0` disables waiting). If capacity stays full, the cell records `CapacityTimeout` and releases its slot. A `SpendCap` 429 records a fault without retrying. The slot limit covers cells in flight, not boxes retained by Mischief after a cell finishes. Prompts are sent once and polled via inspect, including after an ambiguous client disconnect. If the pending prompt clears without a new turn, the runner records `TurnLost`. A turn without confirmed completion after 30 minutes records a fault. The box may still be running; inspect it before acting on it.

## Read or resume a run

`runs/box-swarm/<swarmId>/SUMMARY.md` and `summary.json` contain the counts and per-cell outcomes. Each cell has a `result.json` and, if supplied, decoded files under `evidence/`. Runner faults have `pass: null` and `fault`. A bad final line or nonzero exit also leaves `raw-tail.txt` (last 16,384 characters). Keep the run directory private: results, raw tails and evidence can contain test data.

Rerun from the same host and checkout with the same swarm ID to skip prompts for cells with a `result.json`, including faults. `matrix.sha256` binds the swarm to its template, model, workspace, and ordered cell IDs and prompts. Each saved result records that digest. To change the matrix or start a clean retry, use a new swarm ID.

An unfinished cell uses the same box ID. If the spawn receipt exists, the runner inspects the box rather than replaying a pending prompt. If the remote spawn succeeded but its local receipt is missing, the runner repeats Mischief's idempotent spawn for the same box ID. Do not drive these boxes from another client during the run. The runner reports and clears a stale `.runner.lock` if the local PID is dead. It never takes a lock from a live PID.

With `--destroy`, the runner saves the result before making one discard request for each newly finished cell whose box it confirmed. It records the outcome in `destroy.json` and the summaries. `ReplicaPending` is reported, not retried. The runner never bypasses custody. Rerun with `--destroy` to send only the missing discard for a saved result whose box was confirmed. If the runner was interrupted after recording the attempt, it reports the unconfirmed discard and does not try again. Inspect the peon and follow Mischief's custody process in that case. The command exits nonzero for failed cells, cell faults or teardown faults other than `ReplicaPending`.
