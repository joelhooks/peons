// arrow: the Arrows peon's only paid tool. A composition root: it reads facts,
// asks the pure decisions, does the IO, and appends what happened.
//
//   node bin/arrow.ts generate <job.json> --out <dir> [--digest <template digest>]
//
// Prints one ArrowArtifact JSON line. Exit 3 means refused.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";

import { made, refused } from "../src/artifact.ts";
import type { ArrowArtifact } from "../src/artifact.ts";
import { decodeJob, prepare, QuiverRefusal, send, sha256 } from "../src/quiver.ts";
import { decideSpend, parseLedger } from "../src/spend.ts";
import type { LedgerFact } from "../src/spend.ts";
import type { ArrowRefusal } from "../src/template-node.ts";
import { themify } from "../src/themify.ts";

const LEDGER = process.env.PEON_QUIVER_LEDGER ?? nodePath.join(homedir(), ".local/state/peons/quiver-ledger.jsonl");
// Joel approved a 10-call Arrow 2 proof on 2026-10-15. Raising the cap is his call.
const CAP = Number(process.env.PEON_QUIVER_CALL_CAP ?? "10");

const flag = (name: string) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

// A missing ledger is an empty history. A corrupt one throws: never guess spend.
const readLedger = (): LedgerFact[] => {
  let text: string;
  try {
    text = readFileSync(LEDGER, "utf-8");
  } catch {
    return [];
  }
  return parseLedger(text);
};

const append = (fact: Omit<LedgerFact, "at"> & Record<string, unknown>) => {
  mkdirSync(nodePath.dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), ...fact })}\n`);
};

const leaseKey = () =>
  process.env.QUIVER_API_KEY ??
  execFileSync("secrets", ["lease", "quiver_api_key", "--ttl", "15m", "--client-id", "peons-arrow"], { encoding: "utf-8" }).trim();

const finish = (artifact: ArrowArtifact, why?: string) => {
  console.log(JSON.stringify(why === undefined ? artifact : { ...artifact, why }));
  if (artifact.outcome.kind === "refused") {process.exit(3);}
};

const [command, jobPath] = process.argv.slice(2);
const out = flag("--out");
const digest = flag("--digest") ?? process.env.PEON_TEMPLATE_DIGEST ?? "0".repeat(64);
if (command !== "generate" || jobPath === undefined || out === undefined) {
  console.error("usage: node bin/arrow.ts generate <job.json> --out <dir> [--digest <sha256>]");
  process.exit(2);
}
const job = decodeJob(readFileSync(jobPath, "utf-8"));

const refuse = (refusal: typeof ArrowRefusal.Type, why: string) => {
  append({ event: "refused", refusal, requestId: job.requestId, why });
  finish(refused(job.requestId, digest, refusal, job.model), why);
};

try {
  const request = await prepare(job);
  const spend = decideSpend(readLedger(), CAP);
  if (spend.kind === "exhausted") {
    refuse("envelope-exhausted", `${spend.used} of ${spend.cap} approved Quiver calls already used`);
  } else {
    append({ call: spend.call, cap: spend.cap, event: "reserved", model: job.model, requestId: job.requestId });
    const started = Date.now();
    const result = await send(request, { apiKey: leaseKey() });
    const [raw = ""] = result.svgs;
    const themed = themify(raw);
    mkdirSync(out, { recursive: true });
    const svgPath = nodePath.resolve(out, `${job.requestId}.svg`);
    writeFileSync(nodePath.resolve(out, `${job.requestId}.raw.svg`), raw);
    writeFileSync(svgPath, themed);
    const artifact = made(
      { generationId: result.id, model: job.model, requestId: job.requestId, svgPath, svgSha256: sha256(themed), templateDigest: digest },
      result.usage,
      result.listCostUsd,
    );
    writeFileSync(nodePath.resolve(out, `${job.requestId}.artifact.json`), `${JSON.stringify(artifact, null, 2)}\n`);
    append({ event: "settled", generationId: result.id, listCostUsd: artifact.listCostUsd, requestId: job.requestId, seconds: Math.round((Date.now() - started) / 1000), tokens: result.usage });
    finish(artifact);
  }
} catch (error) {
  if (error instanceof QuiverRefusal) {refuse(error.refusal, error.detail);}
  else {throw error;}
}
