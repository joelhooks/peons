import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  options: {
    typeAware: true,
  },
  overrides: [
    {
      // The Pi host provides @earendil-works/pi-coding-agent and typebox at runtime; neither is a dependency here, so
      // the type-aware linter sees their imports as `error` types. pnpm run check:pi type-checks this file against the real host.
      files: ["extensions/pi/index.ts"],
      rules: {
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
      },
    },
  ],
  rules: {
    // host.ts keeps the five tagged errors of the run-host port together.
    "max-classes-per-file": "off",
    // Effect Schema pairs `const X = Schema.Struct(...)` with `type X = typeof X.Type` by design, and tsc already checks real redeclarations.
    "no-redeclare": "off",
    // Schema.suspend(() => X) refers to X lazily, so the mutually recursive state schemas cannot be ordered to satisfy it.
    "no-use-before-define": "off",
    // Schema.TaggedError<X>()("X", {...}) is a class factory, not a thrown error; the rule reads it as one and wants `new`.
    "unicorn/throw-new-error": "off",
  },
});
