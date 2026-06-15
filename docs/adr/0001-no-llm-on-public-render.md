# ADR 0001 — No LLM prose on the public render; PFD ingest is gated

**Date:** 2026-06-14
**Status:** Accepted
**Deciders:** claude (Claude Code) + grok (Grok Build), via the claude-ipc channel; ratified by the maintainer
**Supersedes:** the Phase-3 "provenance infrastructure" defer in `docs/superpowers/specs/2026-06-10-phase2-closeout-design.md` / `OPTIMIZATION.md`

> Provenance: resolved across a 6-round claude↔grok deliberation on 2026-06-14. This
> ADR is the durable conclusion so the next session inherits the decision instead of
> re-deriving it. Where this names files/lines, verify against the live tree before acting.

## Context

CivicLens publishes claims about *named, real politicians* (trade↔vote proximity,
donor networks, revolving-door links). Its three editorial laws are: **primary
sources only**, **neutral framing**, and **fail loudly** (never fall back to
LLM-generated data). The sharpest risk is therefore **P0-external**: a false
published claim about a real person, which is irreversible in the court of public
opinion even if the bug is fixed an hour later. This is a distinct, higher severity
class than internal/developer-facing risks (stale docs, drift).

Two LLM prose blobs currently ship to the public member page with **zero
row-backing**:

1. `members.bio_summary` ← Summarizer `neutralNarrative`/`bio` (`db/load-from-tasks.ts` ~line 220)
2. `members.trade_activity` ← Trade-Analyst narrative, gated on `readyToApply`

Summarizer token-grounding only filters `keyFacts` (`agents/summarizer.ts` ~147–156);
`bio`/`neutralNarrative` bypass it, and `keyFacts` aren't even rendered. So the public
lede and the trade paragraph are unverifiable assertions about named people.

We asked whether a "provenance invariant" (every rendered claim points to the DuckDB
row(s) that justify it) could make the prose safe. The reasoning ran:

- ~80% of the page is **already row-backed** (trades×votes, donors, revolving door,
  pattern cards, outside spending) and only needs a render-time assert.
- For prose, a *presence* check (`refs.length > 0`) is **provenance theater** — an LLM
  can attach real rows to a wrong number. A real check must be **semantic**: rendered
  quantities recomputed from the referenced rows must match, or the claim is dropped.
- Once claims are recomputable atoms (COUNT/SUM/EXISTS/DATE_BEFORE/POSITION) assembled
  by deterministic templates, the LLM's only remaining job is **selection** — which
  true facts lead. But selection is an **editorial** act, not a provenance one, and it
  is the single most impression-shaping act on the page. Semantic-assert fixes
  hallucination but does nothing about selection bias.
- The set of claims a reader needs that are *both* (a) not recomputable from rows *and*
  (b) not editorial is **empty**. (Meta/explainer copy — "what a PTR is" — is static
  site text, not a claim about a person.)

Therefore there is no role for an LLM on the public render that survives the project's
own laws.

## Decision

1. **No LLM-generated prose on the public render — ever.** The Summarizer and
   Trade-Analyst LLM output is demoted to a **back-office analyst**: it persists in
   `pipeline_runs` as a hypothesis aid for the human reviewer and never touches site
   HTML.

2. **The public member page is deterministic, full stop:** structured tables
   (already row-backed), a deterministic bio from DB identity fields
   (`buildCongressBio` shape — party, chamber, state, first-elected, bioguide), and
   static explainer copy.

3. **Selection, if surfaced, is ranked by statistical surprise — not suspicion.**
   Any "significance-ranked claim strip" must rank by the rigor pillar's p-value /
   proximity (surprise vs. the null model), with **significant exculpatory/null
   results eligible to lead**. Ranking by suspicion re-introduces the selection bias
   we just eliminated, relocated from "the LLM chose" to "the threshold chose."

4. **PFD ingest is frozen behind a release gate, not a calendar.** PFD trade
   attribution uses fuzzy last-name matching; a wrong attach is a *fabricated
   allegation*. Unlike the static prose exposure (a fixed pool), every batch /
   `--load-pfd` run is a *faucet* that can mint a new false claim. Therefore:
   **no batch/PFD ingest run ships to DuckDB until a confidence gate with a hard
   drop-don't-guess rule lands in both the load path and the `v_suspicious_trades`
   query layer.** (Verified 2026-06-14: no crontab, no systemd timers, no running
   pipeline processes — the faucet is currently off, so quarantine may ship first
   without a gap. "Daily Automation" is roadmap, not deployed.)

## Sequencing

1. **Now (no ingest dependency):** quarantine LLM prose from `render/build.ts` — stop
   reading `bio_summary`/`trade_activity`; render the deterministic bio. One commit.
2. **Release gate, before the next ingest/batch:** PFD confidence gate +
   drop-don't-guess, in the load path *and* `v_suspicious_trades`. Ingest stays frozen
   until this lands.
3. **Garnish, when templates are ready:** the significance-ranked claim strip. Not a
   blocker — *the tables are the product*; the page is more honest without prose, not
   emptier. Chip headline is a plain citizen-language fact
   ("Traded AAPL 3 days before vote on HR-1234 — on committee — source ↗"); the
   p-value/null-model line is **secondary metadata**, disclosed not headlined. Empty
   state ("No significant patterns found") is a first-class output — never pad the
   strip to look populated.
4. **Golden tests:** write them against the **post-quarantine** render. Claim-strip
   output must be deterministic (stable sort, id tie-break) so it can be asserted
   byte-stable.

## Consequences

- **Positive:** the public page becomes fully auditable and reproducible from primary
  data; hallucination and PFD mis-attribution collapse into deterministic, testable
  checks at known boundaries; the moat ("trace every claim to source rows") is
  realized, not aspirational; quarantine is now unblocked (nothing needs to replace
  the prose).
- **Negative / accepted:** narrative readability on the page is reduced to template
  assembly. We accept this — the trades×votes table (with on-committee / ticker-in-bill
  tags and source links) was already the readability engine; the LLM contributed only
  ~2 paragraphs of unverifiable throat-clearing above it.
- **The hill to die on:** *freeze PFD ingest until the confidence gate lands.* It is
  the only path that can publish a fabricated allegation about a named person; it
  outranks even quarantine the moment any ingest is queued or cron'd.

## Related

- `docs/superpowers/specs/2026-06-10-phase2-closeout-design.md` (Summarizer demotion, deterministic gates)
- `docs/superpowers/specs/2026-05-27-rigor-pillar-design.md` (the p-value / null-model ranker reused for selection)
- `OPTIMIZATION.md` — update the Phase-3 provenance defer to: **"resolved: no LLM on public render (ADR 0001)."**
