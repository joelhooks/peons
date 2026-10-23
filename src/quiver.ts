// Direct client for the QuiverAI REST API (https://docs.quiver.ai/api-reference).
// Peons call Quiver here, not through quiver-mcp or Executor: no 60 s proxy cap,
// base64 references (so internal images are never published), Arrow 2+ only.
// Every boundary is a Schema decode: the job, the reference file, Quiver's reply.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import nodePath from "node:path";

import { Schema } from "effect";

import { ArrowRefusal } from "./template-node.ts";

export const BASE_URL = "https://api.quiver.ai";
export const TIMEOUT_MS = 300_000;

// Joel, 2026-10-15: "use arrows 2+ only". Arrow 1.x retired 2026-10-16.
const ARROW_2_PLUS = /^arrow-(?:[2-9]|[1-9]\d+)(?:-[a-z0-9]+)*$/u;

// USD per million tokens, from https://docs.quiver.ai/api/pricing (2026-10-15).
const RATES: Record<string, { input: number; output: number }> = {
  "arrow-2": { input: 4, output: 20 },
  "arrow-2-telos": { input: 6, output: 30 },
};

export class QuiverRefusal extends Schema.TaggedError<QuiverRefusal>()("QuiverRefusal", {
  detail: Schema.String,
  refusal: ArrowRefusal,
}) {
  override get message(): string {
    return `${this.refusal}: ${this.detail}`;
  }
}

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

export const Reference = Schema.Struct({ path: Schema.String, sha256: Sha256 });
export type Reference = typeof Reference.Type;

export const GenerateJob = Schema.Struct({
  instructions: Schema.optionalKey(Schema.String),
  maxOutputTokens: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ maximum: 65_536, minimum: 1 }))),
  model: Schema.String,
  prompt: Schema.String.check(Schema.isMinLength(1)),
  reasoningEffort: Schema.optionalKey(Schema.Literals(["low", "medium", "high"])),
  references: Schema.optionalKey(Schema.Array(Reference)),
  requestId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u)),
  temperature: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ maximum: 2, minimum: 0 }))),
});
export type GenerateJob = typeof GenerateJob.Type;

export const decodeJob = Schema.decodeUnknownSync(Schema.fromJsonString(GenerateJob));

const Count = Schema.optionalKey(Schema.Int);

// Only the fields we use; Quiver may add more.
const QuiverReply = Schema.Struct({
  data: Schema.Array(Schema.Struct({ svg: Schema.String })),
  id: Schema.String,
  usage: Schema.optionalKey(
    Schema.Struct({
      input_tokens: Count,
      input_tokens_details: Schema.optionalKey(Schema.Struct({ cached_tokens: Count })),
      output_tokens: Count,
    }),
  ),
});
const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(QuiverReply));

export const Usage = Schema.Struct({ cacheRead: Schema.Int, input: Schema.Int, output: Schema.Int });
export type Usage = typeof Usage.Type;

export interface Generation {
  readonly id: string;
  readonly svgs: readonly string[];
  readonly usage: Usage;
  readonly listCostUsd: number;
}

export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export const assertArrow2Plus = (model: string) => {
  if (!ARROW_2_PLUS.test(model)) {
    throw new QuiverRefusal({ detail: `${model} is not Arrow 2 or later`, refusal: "model-not-allowed" });
  }
};

// Read a reference, check it is the file the request named, and only then encode it.
export const loadReference = async (requestId: string, ref: Reference) => {
  const unreadable = (detail: string) => new QuiverRefusal({ detail: `request ${requestId}: ${detail}`, refusal: "reference-unreadable" });
  if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(nodePath.extname(ref.path).toLowerCase())) {
    throw unreadable(`${ref.path} is not PNG, JPEG, WebP, GIF or SVG`);
  }
  const bytes = await readFile(ref.path).catch(() => {
    throw unreadable(`cannot read ${ref.path}`);
  });
  const actual = sha256(bytes);
  if (actual !== ref.sha256) {throw unreadable(`${ref.path} is ${actual}, expected ${ref.sha256}`);}
  return { base64: bytes.toString("base64") };
};

export const priceUsd = (model: string, usage: Usage) => {
  const rate = RATES[model];
  if (rate === undefined) {return Number.NaN;}
  const uncached = Math.max(0, usage.input - usage.cacheRead);
  return (uncached * rate.input + usage.cacheRead * rate.input * 0.1 + usage.output * rate.output) / 1_000_000;
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PreparedRequest { readonly model: string; readonly body: Record<string, unknown> }

// Everything that can refuse before money moves: the model and every reference.
export const prepare = async (job: GenerateJob): Promise<PreparedRequest> => {
  assertArrow2Plus(job.model);
  const references = await Promise.all((job.references ?? []).map(async (ref) => await loadReference(job.requestId, ref)));
  return {
    body: {
      model: job.model,
      n: 1,
      prompt: job.prompt,
      stream: false,
      ...(job.instructions === undefined ? {} : { instructions: job.instructions }),
      ...(job.reasoningEffort === undefined ? {} : { reasoning_effort: job.reasoningEffort }),
      ...(job.maxOutputTokens === undefined ? {} : { max_output_tokens: job.maxOutputTokens }),
      ...(job.temperature === undefined ? {} : { temperature: job.temperature }),
      ...(references.length === 0 ? {} : { references }),
    },
    model: job.model,
  };
};

// The paid call. Only a prepared request can be sent.
export const send = async (
  request: PreparedRequest,
  options: { readonly apiKey: string; readonly fetchImpl?: FetchLike; readonly baseUrl?: string },
): Promise<Generation> => {
  const fetchImpl = options.fetchImpl ?? (async (url, init) => await fetch(url, init));
  const response = await fetchImpl(`${options.baseUrl ?? BASE_URL}/v1/svgs/generations`, {
    body: JSON.stringify(request.body),
    headers: { accept: "application/json", authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((error: unknown) => {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new QuiverRefusal({ detail: String(error), refusal: timedOut ? "provider-timeout" : "provider-error" });
  });
  const text = await response.text();
  if (!response.ok) {throw new QuiverRefusal({ detail: `HTTP ${response.status}: ${text.slice(0, 500)}`, refusal: "provider-error" });}

  let reply: typeof QuiverReply.Type;
  try {
    reply = decodeReply(text);
  } catch (error) {
    throw new QuiverRefusal({ detail: `unexpected reply shape: ${String(error).slice(0, 300)}`, refusal: "not-svg" });
  }
  const svgs = reply.data.map((item) => item.svg);
  if (svgs.length === 0 || !svgs.every((svg) => /<svg[\s>]/u.test(svg))) {
    throw new QuiverRefusal({ detail: `generation ${reply.id} returned no SVG`, refusal: "not-svg" });
  }
  const usage: Usage = {
    cacheRead: reply.usage?.input_tokens_details?.cached_tokens ?? 0,
    input: reply.usage?.input_tokens ?? 0,
    output: reply.usage?.output_tokens ?? 0,
  };
  return { id: reply.id, listCostUsd: priceUsd(request.model, usage), svgs, usage };
};

export const generate = async (
  job: GenerateJob,
  options: { readonly apiKey: string; readonly fetchImpl?: FetchLike; readonly baseUrl?: string },
): Promise<Generation> => {
  const request = await prepare(job);
  return await send(request, options);
};
