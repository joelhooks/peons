import type { RunReport } from "./run-report.ts";

// USD per million tokens, standard-tier list prices, checked 2026-10-12.
// This estimates list-price-equivalent usage, not the provider's invoice.
const prices: Readonly<Record<string, { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }>> = {
  "claude-opus-5-5": { cacheRead: 0.2, cacheWrite: 5, input: 4, output: 20 },
  "gpt-6.1-sol": { cacheRead: 0.1, cacheWrite: 2.5, input: 2, output: 10 },
  opus: { cacheRead: 0.2, cacheWrite: 5, input: 4, output: 20 },
  sol: { cacheRead: 0.1, cacheWrite: 2.5, input: 2, output: 10 },
};
// A type alias keeps usage assignable to Schema.Json's string-indexed object type.
// oxlint-disable-next-line typescript/consistent-type-definitions
export type Usage = { readonly cacheRead: number; readonly cacheWrite: number; readonly input: number; readonly output: number };

// Before Mischief #27, the line's total includes cache writes but its token object omits them.
// Never turn an unparseable/inconsistent total into free cache writes.
export const usageOf = (thinking: RunReport["thinking"]): Usage | null => {
  if (thinking === undefined) {return null;}
  const { tokens } = thinking;
  if (tokens.cacheWrite !== undefined) {return { ...tokens, cacheWrite: tokens.cacheWrite };}
  const totalText = /(?:^|·)\s*(?<total>[\d,]+)\s+tok(?:\s|·|$)/u.exec(thinking.line)?.groups?.total;
  if (totalText === undefined) {return null;}
  const total = Number(totalText.replaceAll(",", ""));
  const cacheWrite = total - tokens.input - tokens.output - tokens.cacheRead;
  if (!Number.isSafeInteger(total) || cacheWrite < 0) {return null;}
  return { ...tokens, cacheWrite };
};

export const listCost = (models: readonly string[], thinking?: RunReport["thinking"]): { readonly costUsd: number | null; readonly costReason: string | null; readonly tokens: Usage | null } => {
  const tokens = usageOf(thinking);
  const unique = [...new Set(models)];
  const frozenModel = unique.length === 1 ? unique[0] : undefined;
  const model = frozenModel?.replace(/^(?:openai-codex|anthropic)\//u, "");
  const price = model === undefined ? undefined : prices[model];
  if (price === undefined) {return { costReason: model === undefined ? "missing or mixed frozen profile models" : `unknown list price for model ${model}`, costUsd: null, tokens };}
  if (tokens === null) {return { costReason: "missing token usage or cache-write total", costUsd: null, tokens };}
  return { costReason: null, costUsd: (tokens.input * price.input + tokens.output * price.output + tokens.cacheRead * price.cacheRead + tokens.cacheWrite * price.cacheWrite) / 1_000_000, tokens };
};
