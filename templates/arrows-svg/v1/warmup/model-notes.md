# Arrow 2 model notes (2026-10-15)

Sources: `docs.quiver.ai/developers/models`, `docs.quiver.ai/api/pricing`, a free `quiver_models` call on 2026-10-15, and Piper's runs.

| | arrow-2 | arrow-2-telos |
|---|---|---|
| Use for | Most work: speed and cost | Dense geometry, long instructions, fine detail |
| Context | 131,072 tokens | 1,050,000 tokens |
| Max output | 65,536 tokens | 65,536 tokens |
| Input / cached / output, per 1M tokens | $4 / $0.40 / $20 | $6 / $0.60 / $30 |
| Operations in our catalog | generate, vectorize, edit, animate, open_responses | same |

- Arrow 1.x (`arrow-1`, `arrow-1.1`, `arrow-1.1-max`, `arrow-preview`) retired on 2026-10-16 at 08:00 UTC. Joel: Arrow 2 or later only.
- `quiver_models` returns an empty `pricingCredits` for Arrow 2 because it's token-billed. One credit is $0.01 of the same prepaid balance.

## Real runs (Piper, Arrow 2, medium reasoning)

| Run | Reference | Input tokens | Output tokens | Cost |
|---|---|---|---|---|
| pilot | none | 1,338 | 21,497 | about $0.44 |
| chewed-cardboard | exact base render | 1,862 | 15,479 | about $0.32 |

A dense Tube-map SVG costs about $0.30–0.45 on Arrow 2.
