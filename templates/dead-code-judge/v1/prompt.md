Apply `rubric` to the JSON array in `batch`, whose items have an id of path#name. Judge only those ids against Knacker's grep evidence in `evidence`. Apply desk-specific known gaps from optional `rules`; do not assume those gaps for other desks.

Use these verdicts:
- dead: no caller anywhere, including dynamic loads (string paths, import(), node scripts/x in workflows, package.json, turbo.json, lefthook, skills).
- live: a caller exists in code, scripts, config or skills.
- drop-export: no outside caller, but "lines in own file" above 1; the fix is removing the export keyword.
- unsure: evidence cannot settle it; this is a normal answer, not a failure. Missing dynamic-load or caller coverage is not proof of dead code.

`.brain` hits are docs, not callers. Do not count them as live callers. Do not treat no outside caller as dead when own-file use supports drop-export. Cite exact evidence for every verdict, including unsure, and calibrate confidence to coverage. Never emit a run value of rejected merely because code is live or evidence is inconclusive.

Write only the peons.verdict.dead-code.v1 JSON object defined in `rubric`, with exactly one item per batch id and all fields present. Do not wrap it in Markdown. Do not perform the suggested deletion or export change.
