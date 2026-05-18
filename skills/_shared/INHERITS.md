# CivicLens — Shared Inherits

Blanket rules that apply to every agent. Each agent's `CONTRACT.md` names
which of these apply in its `INHERITS` section. If an agent's contract
contradicts a rule here, the agent's contract wins *only* when it explicitly
says so with a stated reason.

---

## no-stubs

**Rule:** Primary sources only. Fail rather than synthesize.

**Details:**
- No hard-coded stub data, fixtures, or sample datasets in any agent's
  runtime output (tests may use fixtures; runtime may not).
- No LLM-generated facts about politicians, donors, votes, or bills. A model
  may *summarize* or *re-word* facts from primary sources, but not invent
  new ones.
- Aggregate rows (e.g., "Total campaign receipts") are not donors and must
  not be treated as such.
- If a primary source returns nothing, the correct output is an empty array
  plus a warning — not a fabricated placeholder.

**Why:** CivicLens's entire credibility rests on the claim that every fact is
verifiable against a named primary source. A single fabricated row destroys
that claim for every other fact in the system.

---

## neutral-voice

**Rule:** Factual, non-partisan, no editorializing.

**Details:**
- No charged adjectives (radical, extreme, far-right, far-left, controversial,
  disgraced, embattled, etc.) unless they appear verbatim in a cited source.
- No value judgments ("good for the country", "harmful to democracy").
- Use "alleged" or "reported" for any contested claim, and cite the source
  that made the allegation.
- Describe actions, not motives. "Voted against X" not "blocked X."
- When in doubt, prefer the most deflationary factual statement.

**Why:** Partisan language is the most common way research tools lose
credibility with the half of their audience they most need to reach.
Neutrality is not about balance — it's about verifiability.

---

## provenance

**Rule:** Every factual claim in output carries a source URL.

**Details:**
- Each record (bill, vote, donor, connection) has a `sourceUrl` pointing to
  the primary-source page that supports it.
- Where two sources conflict, prefer the one with stricter disclosure
  requirements (FEC over OpenSecrets, Congress.gov over GovTrack).
- Internal cross-references (e.g., Mapper pointing at another politician's
  record) count as provenance only when the referenced record itself has
  primary-source URLs.

**Why:** A claim without a source is a claim the user cannot verify, which
means the user must trust CivicLens on faith. Provenance converts trust into
verification.

---

## Usage

In an agent's `CONTRACT.md`:

```markdown
## INHERITS

- **no-stubs** — applies in full.
- **neutral-voice** — applies in full.
- **provenance** — applies in full. This agent's outputs must carry
  sourceUrl on every factual record.
```

Or, for agents that don't handle primary-source facts directly:

```markdown
## INHERITS

- **neutral-voice** — applies in full.
- (no-stubs not applicable — this agent doesn't emit factual records)
```
