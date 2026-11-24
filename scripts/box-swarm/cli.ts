import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { Effect, Schema } from "effect";

import { DEFAULT_AUDIENCE, leasedSigner, serviceToken } from "../../extensions/pi/live-host.ts";
import { decodeReport, refusalSchema, tombstoneSchema, WorkerRefusalError } from "./protocol.ts";
import type { WorkerPort } from "./protocol.ts";
import { runSwarm } from "./runner.ts";

const usage = "Usage: MISCHIEF_HOST=<origin> node scripts/box-swarm/cli.ts <swarm-id> <matrix.json> [--destroy]";

const liveWorker = (origin: URL): WorkerPort => {
  const signer = leasedSigner("rat_king_fleet_agent_peons.desk_identity");
  const call = async (method: "spawnPeon" | "inspectPeon" | "promptPeon" | "destroyPeon", input: unknown, cancel?: AbortSignal): Promise<unknown> => {
    const timeout = AbortSignal.timeout(method === "inspectPeon" ? 15_000 : 120_000);
    const signal = cancel === undefined ? timeout : AbortSignal.any([cancel, timeout]);
    const token = await serviceToken(await Effect.runPromise(signer), {
      aud: process.env.MISCHIEF_AUDIENCE ?? DEFAULT_AUDIENCE,
      lxm: `sh.mschf.mischief.${method}`,
      now: Math.floor(Date.now() / 1000),
    });
    const response = await fetch(new URL(`/${method}`, origin), {
      body: JSON.stringify(input), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, method: "POST", redirect: "error", signal,
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      if (Schema.is(refusalSchema)(body)) { throw new WorkerRefusalError(response.status, body.code, body.reason); }
      throw new WorkerRefusalError(response.status, undefined, `${method} refused`);
    }
    const body: unknown = await response.json();
    return body;
  };

  return {
    async destroy(input) {
      const report = await call("destroyPeon", input);
      if (!Schema.is(tombstoneSchema)(report) || report.peonId !== input.peonId) {
        throw new Error("Mischief did not confirm destruction; inspect the peon before acting again");
      }
    },
    inspect: async (peonId) => decodeReport(await call("inspectPeon", { peonId }), peonId),
    prompt: async (input, signal) => decodeReport(await call("promptPeon", input, signal), input.peonId),
    spawn: async (input) => decodeReport(await call("spawnPeon", input), input.peonId),
  };
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const [swarmId, matrixPath, option] = args;
  if (swarmId === undefined || swarmId.startsWith("-") || matrixPath === undefined || matrixPath.startsWith("-") || (option !== undefined && option !== "--destroy") || args.length > 3) {
    throw new Error(usage);
  }
  const origin = new URL(process.env.MISCHIEF_HOST ?? "");
  if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("MISCHIEF_HOST must be an HTTP(S) origin, with no path, credentials, query or fragment");
  }
  const input: unknown = JSON.parse(await readFile(matrixPath, "utf-8"));
  const root = path.resolve("runs/box-swarm");
  const summary = await runSwarm({ destroy: option === "--destroy", input, root, swarmId, worker: liveWorker(origin) });
  console.log(`${summary.pass} pass, ${summary.fail} fail, ${summary.fault} fault. See ${path.resolve(root, swarmId, "SUMMARY.md")}`);
  if (summary.fault > 0 || summary.fail > 0 || summary.cells.some(({ teardown }) => teardown?.status === "fault")) { process.exitCode = 1; }
};

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
