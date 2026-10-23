// ArrowArtifact values, built from facts and validated against the one schema
// in template-node.ts. No IO here.
import { Schema } from "effect";

import { ArrowArtifact } from "./template-node.ts";
import type { ArrowRefusal } from "./template-node.ts";
import type { Usage } from "./quiver.ts";

export type ArrowArtifact = typeof ArrowArtifact.Type;

const validate = Schema.decodeUnknownSync(ArrowArtifact);

export const made = (
  input: { requestId: string; templateDigest: string; model: string; generationId: string; svgSha256: string; svgPath: string },
  usage: Usage,
  listCostUsd: number,
): ArrowArtifact =>
  validate({
    listCostUsd: Number(listCostUsd.toFixed(4)),
    outcome: {
      generationIds: [input.generationId],
      kind: "made",
      model: input.model,
      svgPath: input.svgPath,
      svgSha256: input.svgSha256,
    },
    requestId: input.requestId,
    templateDigest: input.templateDigest,
    tokens: usage,
  });

export const refused = (
  requestId: string,
  templateDigest: string,
  refusal: typeof ArrowRefusal.Type,
  model: string | null,
): ArrowArtifact =>
  validate({
    listCostUsd: 0,
    outcome: { kind: "refused", model, refusal },
    requestId,
    templateDigest,
    tokens: { cacheRead: 0, input: 0, output: 0 },
  });
