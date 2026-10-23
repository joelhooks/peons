import { defineConfig } from "vitest/config";

// Only our tests: .agent_sources holds a hydrated Effect checkout with its own suites.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
