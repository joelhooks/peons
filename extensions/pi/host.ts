// The run host the tools drive: four Mischief capabilities, submitPlan, inspectRun, deliverReply
// (an ask's reply) and answerRun (a judge escalation's choice).
// The live adapter speaks them over HTTP; tests use an in-memory host. Durability, visits and
// idempotency on runId belong to Mischief; the port only carries calls.
import type { Effect } from "effect";
import { Schema } from "effect";

import type { MischiefSubmission } from "../../src/compile.ts";
import type { ReplyLine, RunReport } from "../../src/run-report.ts";

export class UnknownRun extends Schema.TaggedError<UnknownRun, { readonly brand: unique symbol }>()("UnknownRun", { runId: Schema.String }) {}

export class PlanRefused extends Schema.TaggedError<PlanRefused, { readonly brand: unique symbol }>()("PlanRefused", { errors: Schema.Array(Schema.String) }) {}

export class ReplyRefused extends Schema.TaggedError<ReplyRefused, { readonly brand: unique symbol }>()("ReplyRefused", { reason: Schema.String, replyTo: Schema.String }) {}

export class AnswerRefused extends Schema.TaggedError<AnswerRefused, { readonly brand: unique symbol }>()("AnswerRefused", { reason: Schema.String, runId: Schema.String }) {}

// A transport or protocol failure, already phrased as a 4-line prompt.
export class HostFailure extends Schema.TaggedError<HostFailure, { readonly brand: unique symbol }>()("HostFailure", { message: Schema.String }) {}

export interface RunHostPort {
  readonly submit: (runId: string, plan: MischiefSubmission, docs: Readonly<Record<string, Schema.Json>>) => Effect.Effect<RunReport, PlanRefused | HostFailure>;
  readonly inspect: (runId: string) => Effect.Effect<RunReport, UnknownRun | HostFailure>;
  readonly deliver: (line: ReplyLine) => Effect.Effect<RunReport, ReplyRefused | HostFailure>;
  readonly answer: (runId: string, reply: string) => Effect.Effect<RunReport, AnswerRefused | UnknownRun | HostFailure>;
}
