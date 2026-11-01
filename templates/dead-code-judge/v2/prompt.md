Apply `rubric` to the JSON array in `batch`, whose items have an id of path#name or a whole-file path with no # (including file and test-only-file findings). Judge only those ids, by reading and searching the checkout at /work yourself. Apply desk-specific known gaps from optional `rules`; do not assume those gaps for other desks.

Rules:
- A `dead` verdict must quote at least one `path:line` for the definition, plus the exact grep command it ran across `/work` and that command's empty result, after excluding the definition line.
- Test and fixture references count as use: anything under `test/`, `__tests__/`, `*.test.*`, `*.spec.*`, `fixtures/`.
- Dynamic callers count as callers: string paths, `import()`, `node scripts/x` in workflows, package.json, turbo.json, lefthook and skills. `.brain` hits are docs, not callers.
- `drop-export`, `live` and `unsure` mean what they mean in v1. `unsure` is a normal answer.

Use these verdicts:
- dead: no caller anywhere in /work, including tests, fixtures and dynamic loads.
- live: a caller exists in code, tests, fixtures, scripts, config or skills.
- drop-export: no outside caller, but the symbol is used more than once in its own file; the fix is removing the export keyword.
- unsure: the checkout cannot settle it; this is a normal answer, not a failure. A search you could not run or could not scope is not proof of dead code.

Do not treat no outside caller as dead when own-file use supports drop-export. Cite exact /work lines for every verdict, including unsure, and calibrate confidence to coverage. Never emit a run value of rejected merely because code is live or the checkout is inconclusive.

Write only the peons.verdict.dead-code.v2 JSON object defined in `rubric`, with exactly one item per batch id and all fields present. Do not wrap it in Markdown. Do not perform the suggested deletion or export change.
