import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { describe, expect, it } from "vitest";

import { PeonRefused } from "../src/contract.ts";
import type { PeonRequest } from "../src/contract.ts";
import { canonical, compile, loadTemplate, mischiefRunId, TemplateCorrupt } from "../src/think-template.ts";

const dirOf = (name: string) => new URL(`../templates/${name}/v1`, import.meta.url).pathname;
const review = loadTemplate(dirOf("change-review"));
const investigation = loadTemplate(dirOf("investigation"));

const request = (docs: Record<string, string>, extra: Partial<PeonRequest> = {}): PeonRequest => ({
  base: null,
  desk: "drovr/drovr-desk-2",
  input: { docs, kind: "brief", text: "Is this release safe to ship?" },
  runId: "release-42/review#1",
  schema: "peons.request.v1",
  scope: [],
  target: { kind: "template", template: "change-review", version: 1 },
  ...extra,
});

const isRefused = Schema.is(PeonRefused);

const tagOf = (result: ReturnType<typeof compile>) => (isRefused(result) ? result.tag : "compiled");

const PeonStepPlan = Schema.Struct({ machine: Schema.Struct({ states: Schema.Struct({ peon: Schema.Struct({ meta: Schema.Struct({ step: Schema.Record(Schema.String, Schema.String) }) }) }) }) });

describe("think templates", () => {
  it("load, verify every file hash, and name a stable digest", () => {
    for (const loaded of [review, investigation]) {
      expect(loaded.digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(loadTemplate(dirOf(loaded.spec.template)).digest).toBe(loaded.digest);
      expect(Object.keys(loaded.warmup)).toEqual(["rules"]);
    }
  });

  it("refuse to load when a warmup file changed without a new hash", () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "peons-template-"));
    cpSync(dirOf("change-review"), dir, { recursive: true });
    writeFileSync(nodePath.join(dir, "warmup.md"), "tampered");
    expect(() => loadTemplate(dir)).toThrow(TemplateCorrupt);
  });

  it("compile a valid brief into one think that reads the warmup, the brief and only the docs given", () => {
    const compiled = compile(review, request({ criteria: "no regressions", subject: "diff --git a/x b/x" }));
    expect(isRefused(compiled)).toBe(false);
    if (isRefused(compiled)) {return;}
    expect(compiled.runId).toBe(mischiefRunId("drovr/drovr-desk-2", "release-42/review#1"));
    expect(compiled.runId).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/u);
    expect(compiled.escalateTo).toBe("drovr/drovr-desk-2");
    expect(Object.keys(compiled.docs).toSorted()).toEqual(["brief", "criteria", "rules", "subject"]);
    const { step } = Schema.decodeUnknownSync(PeonStepPlan)(compiled.plan).machine.states.peon.meta;
    expect(Object.keys(step).toSorted()).toEqual(["kind", "prompt", "writes"]);
    expect([...(step.prompt ?? "").matchAll(/\{\{docs\.(?<name>[a-z_-]+)\}\}/gu)].map((match) => match[1])).toEqual(["rules", "brief", "criteria", "subject"]);
    expect(step.prompt?.startsWith("## rules")).toBe(true);
    expect(step.writes).toBe("review");
  });

  it("refuse before spending, with the four-line shape", () => {
    expect(tagOf(compile(review, request({})))).toBe("MissingInput");
    expect(tagOf(compile(review, request({ secrets: "y", subject: "x" })))).toBe("UnknownInput");
    expect(tagOf(compile(review, request({ subject: "x".repeat(400_001) })))).toBe("InputTooLarge");
    expect(tagOf(compile(review, request({ subject: "x" }, { input: { data: {}, kind: "event", name: "release.ready" } })))).toBe("EventNotAccepted");
    expect(tagOf(compile(review, request({ subject: "x" }, { target: { kind: "template", template: "change-review", version: 2 } })))).toBe("TemplateMismatch");
    expect(tagOf(compile(investigation, request({ evidence: "x" })))).toBe("TemplateMismatch");
    expect(tagOf(compile(review, request({ subject: "x" }, { target: { kind: "work-type", workType: "review" } })))).toBe("TemplateMismatch");
    const refused = compile(review, request({}));
    expect(isRefused(refused) && [refused.accepted, refused.fix, refused.debug].every((line) => line.length > 0)).toBe(true);
  });

  it("compile is deterministic: the same request always gives byte-identical plan and docs", async () => {
    const result = await Effect.runPromise(
      Arbitrary.checkEffect(
        Arbitrary.schema(Schema.Struct({ criteria: Schema.String, runId: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9/#:-]{0,40}$/u)), subject: Schema.String })),
        ({ runId, subject, criteria }) => {
          const once = compile(review, request({ criteria, subject }, { runId }));
          const twice = compile(review, request({ criteria, subject }, { runId }));
          return canonical(once) === canonical(twice);
        },
        { runs: 200 },
      ),
    );
    expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
  });

  it("two desks never share a Mischief run for the same peon run id", () => {
    expect(mischiefRunId("drovr/drovr-desk-2", "r1")).not.toBe(mischiefRunId("front-desk/front-desk-desk", "r1"));
  });
});
