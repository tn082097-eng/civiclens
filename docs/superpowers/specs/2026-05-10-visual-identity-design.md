# CivicLens — Visual Identity v1

**Date:** 2026-05-10
**Status:** Design (pre-implementation)
**Owner:** duckjustice
**Scope:** First real visual pass on the member profile page rendered by `render/build.ts`. Palette, typography, intensity rendering, party-tag treatment. No layout changes, no new dependencies.

---

## Why

The profile redesign v1 (2026-05-03) shipped the right *structure*: 8 sections, intensity-mapped trade rows, real data flowing end-to-end. But the page is, in the user's words, "painfully unappealing." Adoption is the entire point of a transparency project — if the page reads as inert, no one stays long enough to verify a finding. This pass fixes the surface problems without touching the structure.

It also fixes a real editorial bug: the current `intensity-high` style uses red (`#d65a5a`), which contradicts the redesign spec's no-moralizing-color rule. The intensity work shipped, the visual rule did not. This pass corrects that.

## Editorial constraints (non-negotiable)

Inherited from civiclens-core. Any decision in this spec defers to them.

- **No moralizing color.** Color affect cannot tell the reader the answer. Intensity surfaces through weight, density, and typography — never through saturated red/yellow fills.
- **Party affiliation is factual data.** Party tags may use partisan colors *because they label a fact* (D, R, I). The rest of the page does not.
- **Neutrality across members.** A quiet member's page should feel quiet. A loud member's page should feel loud. Loud ≠ guilty.
- **No engagement-driven flourishes.** No glows, no pulse animations, no "intense and satisfying" affect. Striking via discipline, not noise.

## Design decisions

### Palette — warm-dark inversion

Replace the cool near-black + partisan blue accent with a warm-charcoal + bone-white scheme. Removes the blue cast that makes the current page lean partisan-Democrat at a glance.

| Variable | Old | New | Notes |
|---|---|---|---|
| `--bg` | `#0e1014` (cool near-black) | `#14110d` (warm charcoal) | |
| `--fg` | `#e8eaed` (cool off-white) | `#f5f1e8` (bone white) | |
| `--fg-dim` | `#9aa0a6` | `#a59f8e` | warm dim |
| `--fg-muted` | `#5f6368` | `#6b6557` | warm muted |
| `--line` | `#2a2e35` | `#2e2a22` | warm divider |
| `--accent` | `#79b8ff` (partisan blue) | `#f5f1e8` (= `--fg`) | accent surfaces via weight, not hue |

Party tags are the only place partisan colors survive:
- `--p-d`: `#79b8ff` (D — keep)
- `--p-r`: `#d65a5a` (R — keep)
- `--p-i`: `#9aa0a6` (I — keep)

### Typography — editorial heads, terminal numerals

Three-stack system, no network request:

- **Headings (h1, h2):** serif system stack — `'Charter', 'Source Serif 4', 'Iowan Old Style', Georgia, serif`. Provides editorial weight on macOS/iOS (Charter ships) and degrades cleanly to Georgia elsewhere.
- **Body:** existing system-sans stack stays.
- **Numerals (counts, dates, dollar amounts):** `'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace` with `font-variant-numeric: tabular-nums`. Applies via a `.num` utility class on cells that hold numbers, plus directly on the at-a-glance grid and trade-card numeric fields.

Tabular numerals make columns of dollars and counts align as columns instead of jittering. Single biggest perceived-quality win in the entire pass.

### Intensity — weight and density only

| Class | Border-left | Padding-left | Numeric font-size | Color treatment |
|---|---|---|---|---|
| `intensity-low` | 1px solid `--line` | 12px | 13px | none |
| `intensity-medium` | 2px solid `--fg-dim` | 14px | 13px | none |
| `intensity-high` | 3px solid `--fg` | 16px | 14px | none |

All `rgba(214,90,90,*)` and `rgba(247,201,72,*)` references stripped from intensity classes. The existing `.suspicion-badge` styles (`.medium` yellow fill, `.high` red fill) get the same treatment — replaced with weight-only rendering. The badge keeps its label; loses its color.

### Density / rhythm

- Data row vertical padding: `8px` → `6px` (tighter).
- Section break margin: `32px` → `48px` (wider, more breathing room between sections).
- At-a-glance grid: existing structure, retuned for tabular numerals.

## Architecture

All changes live inside the inline `<style>` block in `render/build.ts` plus minor touch-ups in render functions that emit cells with numeric content (add `.num` class).

No new dependencies. No font hosting. No HTML structure changes. No JavaScript.

### Files touched

- `render/build.ts` — `<style>` block (CSS variables, typography stack, intensity rules, party-tag styles), plus `.num` class additions in cells that render numeric content.

### Files NOT touched

- HTML structure of any section.
- `agents/*`, `pipeline.ts`, `db/*`, schemas, fetchers — no data layer changes.
- Other site pages (about, members index, network views) — the redesign profile page is the entire scope.

## Testing

- Smoke render on MTG (gold standard) and inspect every section.
- Render at least 3 quiet members (low trade volume) and 3 loud members (Pelosi, MTG, Crenshaw or similar) — confirm intensity differentiation reads visibly without color.
- Mobile width (375px viewport) — confirm the warm palette doesn't muddy small text.
- Confirm no member's page leans partisan blue at a glance.
- Side-by-side compare with current site/members/marjorie-taylor-greene.html to verify the new pass actually reads better, not just different.

## Decision log

- **Warm-dark inversion over cool palette.** Removes the partisan-blue cast at the expense of every existing color reference. Largest change; most impactful single fix.
- **Bone-white as `--accent`.** Accent surfaces through weight, not hue. Eliminates the "everything blue" feel.
- **System serif stack, no Google Fonts.** Network requests on a transparency site invite questions about tracking; system stacks degrade cleanly.
- **Keep party-tag partisan colors.** Party affiliation is a fact; the chip is the right place to show it. Stripping the color would obscure data.
- **Intensity weight-only.** Strictest reading of the no-moralizing-color rule. Color contrast is reserved for facts (party), never for editorial implication.
- **No HTML changes.** This is a visual pass. Layout problems get a separate spec if they need one.

## Out of scope (tracked, not v1)

- Members index page restyling.
- About page restyling.
- Network view page restyling.
- Light-mode variant.
- Custom hosted fonts (Charter, Source Serif).
- Iconography or illustration system.
- Interactive elements (filters, sorting) beyond what already exists.
- The `/patterns` page styling — handled in the Pattern Discovery spec.

## Open follow-ups (post-v1)

- Once v1 ships, evaluate whether the bone-white accent has enough hierarchy or whether a single warm functional accent (amber, sage) needs to come back for *non-data* affordances (links, focus rings).
- Decide whether to host Charter/Source Serif explicitly. System stack first; revisit if Linux/Windows readers report ugly serif fallback.
- Consider per-section visual landmarks (small caps section labels, hairline rules) once the type system is stable.
