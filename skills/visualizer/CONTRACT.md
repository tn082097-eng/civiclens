# Visualizer — Agent Contract

Single source of truth for the Visualizer. `pipeline.ts` and Hermes-invoked
runs both follow this file. If code or SKILL.md contradicts, this document wins.

## Purpose

Transform the Connection Mapper's verified output into a Sigma.js-compatible
graph (`nodes` + `edges`) for rendering on the politician's page. This is
pure schema transformation — from one structured JSON shape to another.

## Architecture — single stage, code only

**There is no model call.** The Mapper's output is already structured
(`subjectId`, `sharedDonors`, `directLinks`, `hiddenConnections`). Asking a
model to reshape structured JSON into another structured JSON shape invites
drift and hallucination for zero gain.

Prior versions of this agent called qwen3.6 to do this transformation. That
was overkill and occasionally produced nodes with no corresponding Mapper
entry. The contract replaces it with deterministic code.

## INPUTS

1. `pipeline/<task-id>/connection-mapper.json` — verified network data.
2. No other inputs. No model calls. No external fetches.

## OUTPUTS

Write `pipeline/<task-id>/visualizer.json`:

```json
{
  "taskId":      "task-...",
  "generatedAt": "ISO-8601",
  "graph": {
    "nodes": [
      { "id": "slug", "label": "Full Name", "attributes": { "type": "politician|donor|pac|organization", "size": 10 } }
    ],
    "edges": [
      { "id": "e1", "source": "slug-a", "target": "slug-b",
        "attributes": { "type": "donor|ally|rival|shared-donor|hidden", "strength": 0.0, "label": "..." } }
    ]
  },
  "charts": []
}
```

## MUST DO

1. **Emit one node for the subject politician** using `mapper.subjectId` /
   `mapper.subjectName`, type `politician`.
2. **Emit one node per unique `to` slug** referenced in directLinks +
   hiddenConnections, type `politician` (they come from the corpus).
3. **Emit one node per unique `donorName`** in `sharedDonors`, with type
   `donor` or `pac` depending on what the Researcher classified it as.
4. **Emit edges from subject to each referenced politician** with edge type
   from the source structure (`directLinks` → `direct`, `hiddenConnections`
   → `hidden`).
5. **Emit donor edges** from subject to each shared donor node, type
   `shared-donor`, with `strength` proportional to log(subjectAmount).
6. **Preserve `strength`** values from the Mapper without rescaling.

## MUST NOT

1. Do not invent nodes that aren't derivable from the Mapper output.
2. Do not call any model. The transformation is deterministic.
3. Do not merge node types the Mapper marked as distinct.
4. Do not drop edges with low strength — that's the frontend's job, not the
   Visualizer's.

## INHERITS

- **no-stubs** — applies via dependency. Nodes/edges must be traceable to
  Mapper output.
- **neutral-voice** — not directly applicable (no prose output).
- **provenance** — node labels should let the frontend deep-link to the
  politician's page; donor nodes should carry the sourceUrl from Mapper.

## Failure modes

| Symptom | Cause | Required response |
|---|---|---|
| Mapper output has empty arrays | no verified matches | emit 1-node graph (subject only) + `charts: []` |
| Mapper file missing | Mapper failed earlier | fail the Visualizer — pipeline error |
| Edge references slug with no node | programmer error | log and drop the edge |
