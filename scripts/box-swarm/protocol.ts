import { Buffer } from "node:buffer";

import { Schema } from "effect";

const nonempty = Schema.String.check(Schema.isMinLength(1));
const positive = Schema.Int.check(Schema.isGreaterThan(0));
const slug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/u));
const workspace = Schema.Struct({
  repo: Schema.String.check(Schema.isPattern(/^[a-z\d][a-z\d_.-]*\/[a-z\d][a-z\d_.-]*$/iu)),
  sha: Schema.String.check(Schema.isPattern(/^[a-f\d]{40}$/u)),
});
const matrixSchema = Schema.Struct({
  cells: Schema.Array(Schema.Struct({ brief: nonempty, id: slug, turns: Schema.optionalKey(Schema.Array(nonempty)) })).check(Schema.isMinLength(1)),
  concurrency: Schema.optionalKey(positive),
  model: nonempty,
  template: Schema.Literals(["full@1", "browser@1"]),
  turnBudget: positive,
  workspace,
});
export type Matrix = typeof matrixSchema.Type & { readonly concurrency: number };

export const parseMatrix = (input: unknown, swarmId: string): Matrix => {
  if (!Schema.is(slug)(swarmId)) { throw new Error("Invalid swarm ID: use lowercase letters, digits and hyphens"); }
  const matrix = Schema.decodeUnknownSync(matrixSchema)(input);
  const ids = new Set<string>();
  for (const cell of matrix.cells) {
    if (ids.has(cell.id)) { throw new Error(`Duplicate cell ID: ${cell.id}`); }
    ids.add(cell.id);
    if (`${swarmId}-${cell.id}`.length > 40) { throw new Error(`Peon ID exceeds 40 characters: ${swarmId}-${cell.id}`); }
    if (1 + (cell.turns?.length ?? 0) > matrix.turnBudget) { throw new Error(`Cell ${cell.id} exceeds turnBudget (${matrix.turnBudget})`); }
  }
  return { ...matrix, concurrency: matrix.concurrency ?? (matrix.template === "browser@1" ? 6 : 8) };
};

// Decimal KB; the encoded-length precheck bounds allocation before decoding.
export const evidenceLimit = 300_000;
export const evidenceCount = 4;
const resultSchema = Schema.Struct({
  cell: slug,
  evidence: Schema.Array(Schema.Struct({
    base64: Schema.String.check(Schema.isMaxLength(Math.ceil(evidenceLimit / 3) * 4)),
    mime: Schema.String.check(Schema.isPattern(/^[\w.+-]+\/[\w.+-]+$/u)),
    name: Schema.String.check(Schema.isPattern(/^[a-z\d][a-z\d._-]{0,127}$/iu)),
  })).check(Schema.isMaxLength(evidenceCount)),
  failedStep: Schema.optionalKey(Schema.String),
  notes: Schema.String,
  pass: Schema.Boolean,
});
export type CellResult = typeof resultSchema.Type;
const faultSchema = Schema.Struct({ cell: slug, fault: nonempty, pass: Schema.Null });
export type Result = CellResult | typeof faultSchema.Type;

const parseResult = (input: unknown, id: string) => {
  const result = Schema.decodeUnknownSync(resultSchema)(input);
  if (result.cell !== id) { throw new Error(`Result cell does not match ${id}`); }
  const names = new Set<string>();
  const files = result.evidence.map(({ base64, name }) => {
    const key = name.toLowerCase();
    if (names.has(key)) { throw new Error(`Duplicate evidence filename: ${name}`); }
    names.add(key);
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > evidenceLimit || bytes.toString("base64") !== base64) {
      throw new Error(`Invalid base64 or oversized evidence: ${name}`);
    }
    return { bytes, name };
  });
  return { files, result };
};

export const parseOutput = (output: string, id: string) => {
  const trimmed = output.trimEnd();
  const line = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  try {
    const input: unknown = JSON.parse(line);
    return parseResult(input, id);
  } catch {
    // Schema and JSON parse errors can echo an entire base64 payload.
    throw new Error("Invalid final JSON line or evidence; see raw-tail.txt");
  }
};

export const parseSavedResult = (text: string, id: string): Result => {
  const input: unknown = JSON.parse(text);
  if (Schema.is(faultSchema)(input) && input.cell === id) { return input; }
  return parseResult(input, id).result;
};

const turnSchema = Schema.Struct({ exit: Schema.Finite, output: Schema.String, usage: Schema.Struct({ total: Schema.Finite }), wallMs: Schema.Finite });
export type Turn = typeof turnSchema.Type;
const reportSchema = Schema.Struct({
  fault: Schema.NullOr(Schema.String),
  lastTurn: Schema.NullOr(turnSchema),
  pending: Schema.optionalKey(Schema.NullOr(Schema.Struct({ kind: Schema.String, requestId: Schema.String }))),
  peonId: slug,
  state: Schema.Literals(["spawned", "attaching", "running", "idle", "suspended", "hibernated", "destroyed"]),
});
export type Report = typeof reportSchema.Type;

export const refusalSchema = Schema.Struct({ code: Schema.optionalKey(nonempty), reason: nonempty });
export const tombstoneSchema = Schema.Struct({ peonId: slug, state: Schema.Literal("destroyed") });
export const decodeReport = (input: unknown, peonId: string): Report => {
  if (Schema.is(reportSchema)(input) && input.peonId === peonId) { return input; }
  if (Schema.is(tombstoneSchema)(input) && input.peonId === peonId) { return { ...input, fault: null, lastTurn: null }; }
  throw new Error("Invalid Mischief peon report");
};

export class WorkerRefusalError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, reason: string) {
    super(`${code ?? `HTTP ${status}`}: ${reason}`);
    this.name = "WorkerRefusalError";
    this.status = status;
    this.code = code;
  }
}

export interface WorkerPort {
  readonly spawn: (input: { readonly peonId: string; readonly overrides: { readonly model: string; readonly workspace: Matrix["workspace"] }; readonly template: { readonly name: "full" | "browser"; readonly version: 1 } }) => Promise<Report>;
  readonly prompt: (input: { readonly peonId: string; readonly requestId: string; readonly text: string }, signal: AbortSignal) => Promise<Report>;
  readonly inspect: (peonId: string) => Promise<Report>;
  readonly destroy: (input: { readonly peonId: string; readonly discardWorkspace: true }) => Promise<void>;
}
