# Connection Mapper — Agent Contract

Single source of truth for what the Connection Mapper does. Both `pipeline.ts`
and Hermes-invoked runs must follow this file. If pipeline code or SKILL.md
disagrees with this document, this document wins.

## Purpose

Given one subject politician's researcher output, find relationships to other
politicians, donors, and organizations **by cross-referencing every other
politician's researcher output available in the pipeline**. Zero connections
is an acceptable result only when proven — not when nothing was compared.

## Architecture — two stages

The Mapper runs in two stages. The split is load-bearing: it exists because
models hallucinate shared donors when asked to do string matching, so we do
the matching in code and let the model do only what it's good at (narrative).

- **Stage 1 — deterministic matching (code only, no model):**
  Normalize donor names and intersect the subject's donor set with each
  corpus entry's donor set → `sharedDonors`. Intersect committee systemCodes
  across subjects → `sharedCommittees` (carrying each side's role so Chair/
  Ranking leadership overlaps are distinguishable). No model call. Cannot
  fabricate — every entry is a byte-for-byte match after normalization.

- **Stage 2 — narrative synthesis (model, over verified facts):**
  The model receives ONLY the pre-verified shared donors, shared committees,
  and related politicians' identity fields. It writes `directLinks`,
  `hiddenConnections`, `indirectLinks`, and `networkSummary`. It may not
  invent donors or committees — it can only narrate over the lists stage 1
  produced.

If stage 1 returns zero shared donors **and** zero shared committees, stage 2
is skipped and `networkSummary` records that explicitly. A model cannot
"rescue" a null result.

## INPUTS

1. `pipeline/<current-task-id>/researcher.json` — the subject.
2. Every `pipeline/*/researcher.json` on disk (excluding the subject's own
   task dir), **deduplicated by politician ID keeping the newest run**. Older
   runs for the same politician are stale corpus noise.
3. No other sources. Not `stub-data.json`. Not LLM knowledge. Not the web.

## OUTPUTS

Write `pipeline/<current-task-id>/connection-mapper.json`:

```json
{
  "taskId":            "task-...",
  "analyzedAt":        "ISO-8601",
  "subjectId":         "politician-slug",
  "subjectName":       "Full Name",
  "comparedAgainst":   [{"id": "slug", "name": "Full Name", "taskId": "task-..."}],
  "sharedDonors":      [{"donorName": "...", "sharedWith": ["slug"], "subjectAmount": 0, "otherAmount": 0, "sourceUrl": "..."}],
  "sharedCommittees":  [{"code": "SSJU04", "name": "...", "chamber": "senate|house|joint", "isSubcommittee": true, "subjectRole": "Chair|Ranking Member|Member", "sharedWith": ["slug"], "perOther": {"slug": "Chair|Ranking Member|Member"}, "sourceUrl": "..."}],
  "directLinks":       [{"from": "subject", "to": "slug", "toName": "...", "type": "shared-donor|committee-colleague|committee-leadership|party-ally|state-colleague", "strength": 0.0, "evidence": "..."}],
  "hiddenConnections": [{"from": "subject", "to": "slug", "toName": "...", "via": "...", "type": "...", "strength": 0.0, "evidence": "..."}],
  "indirectLinks":     [{"via": "...", "to": "slug", "toName": "...", "linkType": "...", "strength": 0.0}],
  "networkSummary":    "2-3 neutral sentences"
}
```

`comparedAgainst` is non-optional: it proves the cross-reference happened.

## MUST DO (stage 1, code)

1. **Load every other task's researcher.json** via glob of `pipeline/*/`,
   excluding the current task.
2. **Deduplicate** by politician ID — keep newest by mtime. Multiple runs
   of the same politician must not inflate the corpus.
3. **Populate `comparedAgainst`** with the deduped list.
4. **Match donors by normalized name** (uppercase, strip punctuation, strip
   suffixes JR/SR/II/III/IV). "SMITH, JOHN" and "John Smith Jr." are the
   same donor.
5. **Emit sharedDonors deterministically** from the intersection. Every entry
   has `subjectAmount` from the subject's record and `otherAmount` summed
   across the corpus entries that share it. Include `sourceUrl` from either
   side's record.
6. **Match committees by exact systemCode** (the `code` field — e.g. `SSJU04`
   for the Senate Judiciary subcommittee on Border Security and Immigration).
   Codes are authoritative identity; never match by name or slug. Include
   both parent committees and subcommittees — a shared parent plus a shared
   subcommittee are two distinct overlaps.
7. **Emit sharedCommittees** from the intersection, carrying the subject's
   role (`subjectRole`) and a `perOther` map from corpus slug → that
   politician's role on the same committee. Sort by (a) number of related
   politicians on the overlap, (b) leadership weight of `subjectRole`
   (Chair=2, Ranking Member=1, Member=0). Leadership overlaps surface first
   because they carry the strongest power-dynamic signal.

## MUST DO (stage 2, model)

1. **Receive only pre-verified facts** — the sharedDonors and sharedCommittees
   lists from stage 1, plus identity fields (party/state/chamber) of the
   related politicians. Do not pass raw donor lists, raw committee rosters,
   or unmatched fields to the model.
2. **Every edge the model emits must reference a slug present in
   `relatedPoliticians`.** Edges pointing to other slugs are dropped.
3. **Every `evidence` string must cite a donor name from sharedDonors OR a
   committee code/name from sharedCommittees.** The model is narrating, not
   discovering.
4. **Edge types are fixed** — `shared-donor`, `committee-colleague`,
   `committee-leadership`, `party-ally`, `state-colleague`. Use
   `committee-leadership` only when subject AND target are both Chair or
   Ranking Member of the same committee (asymmetric power dynamic). Use
   `committee-colleague` when both are ordinary members. Don't conflate the
   two — the distinction is the whole point of carrying roles into stage 2.
5. **`networkSummary` must reference at least one shared donor or committee
   by name/code** when stage-1 matches exist; otherwise it states the null
   result.

## MUST NOT

1. Do not invent connections, donors, committees, PACs, or chains not present
   in the loaded researcher.json files.
2. Do not let the model add, remove, or rename entries in `sharedDonors` or
   `sharedCommittees` — both lists are frozen after stage 1.
3. Do not use general LLM knowledge about politicians ("Ted Cruz is known
   to be close to…"). If it isn't in the loaded data, it doesn't exist.
4. Do not load `stub-data.json` or any synthetic dataset.
5. Do not treat aggregate rows (e.g., "Total campaign receipts") as donors
   — they are not and will false-match across politicians.

## INHERITS

- **no-stubs** — primary sources only, fail rather than synthesize.
- **neutral-voice** — no charged language, no editorializing.
- **provenance** — every factual claim in output carries a sourceUrl back
  to the researcher.json field that supports it.

## Failure modes

| Symptom | Cause | Required response |
|---|---|---|
| `comparedAgainst` empty | glob found no other task dirs | warn, emit empty output, mark agent `complete` with warning — do not fail the pipeline |
| Stage 1 yields zero matches | no shared donors AND no shared committees in data | skip stage 2, record in `networkSummary` — this is a valid outcome |
| Stage 2 returns non-JSON | parsing failure | retry once, then emit empty edges (keep stage-1 sharedDonors and sharedCommittees) |
| Model emits edge with unknown slug | slug not in relatedPoliticians | drop the edge |
| Committee codes mismatch by case ("SSFR09" vs "ssfr09") | YAML emits uppercase, Congress.gov meetings emit lowercase | **bug** — `fetch.ts` must normalize, not the Mapper |
| Stage 1 yields matches but `comparedAgainst` empty | impossible state | **fail the agent** |
