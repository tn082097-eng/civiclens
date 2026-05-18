# CivicLens Visual Identity v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the warm-dark / editorial-typography / weight-only-intensity visual pass to the CivicLens member profile page (`render/build.ts`), per the 2026-05-10 visual identity spec.

**Architecture:** Single-file edit to the inline `<style>` block in `render/build.ts` (lines ~161–260). Replace CSS custom properties (palette), add typography stacks (serif headings + monospace numerals), strip color-coded intensity classes in favor of weight/density. No HTML changes, no new dependencies. Render the site after, eyeball one quiet member and one loud member.

**Tech Stack:** TypeScript (`render/build.ts`), DuckDB-backed render pipeline (`npx tsx render/build.ts`), no test framework on this rendering path. Verification is visual.

**Reference spec:** `docs/superpowers/specs/2026-05-10-visual-identity-design.md`

**Precondition:** `render/build.ts` already has uncommitted changes from prior intensity-rendering work. Before starting Task 1, the implementer must either commit the existing diff (`git add render/build.ts && git commit -m "feat(render): intensity rendering for trade cards"`) or stash it. Working from a clean tree on `render/build.ts` makes the visual-pass diff readable in review.

**Verification approach:** This file has no test suite. After each task, the implementer runs `npx tsx render/build.ts` to rebuild the site, then opens `site/members/marjorie-taylor-greene.html` (loud member) AND `site/members/amy-klobuchar.html` (quieter member) in a browser. Both must (a) render without errors, (b) show the change the task introduced, (c) not regress earlier sections. Visual checks are listed in each task's verification step.

---

### Task 1: Replace the palette CSS variables

**Files:**
- Modify: `render/build.ts` lines 162–172 (the `:root` block)

- [ ] **Step 1: Edit the `:root` block in the inline `<style>` template**

Find this block in `render/build.ts` (starts at line 162):

```css
:root {
  --bg: #0e1014;
  --fg: #e8eaed;
  --fg-dim: #9aa0a6;
  --fg-muted: #5f6368;
  --line: #2a2e35;
  --accent: #79b8ff;
  --p-d: #5b9ed8;
  --p-r: #d65a5a;
  --p-i: #b88a3f;
}
```

Replace with:

```css
:root {
  --bg: #14110d;
  --fg: #f5f1e8;
  --fg-dim: #a59f8e;
  --fg-muted: #6b6557;
  --line: #2e2a22;
  --accent: #f5f1e8;
  --p-d: #79b8ff;
  --p-r: #d65a5a;
  --p-i: #9aa0a6;
}
```

Notes on the changes:
- `--bg` cool→warm charcoal
- `--fg` cool→bone-white
- `--accent` partisan blue → bone-white (same as `--fg`); accent surfaces via weight, not hue
- Party tags keep partisan colors (per spec: party affiliation is factual data); `--p-d` adjusted to the original full saturation, `--p-i` flattened to muted grey

- [ ] **Step 2: Rebuild the site and inspect**

Run:

```bash
cd ~/.hermes/civiclens && npx tsx render/build.ts 2>&1 | tail -20
```

Expected: build succeeds, no errors. If you see TypeScript or runtime errors, investigate before proceeding — the change is purely textual and should not break the build.

Open `site/members/marjorie-taylor-greene.html` in a browser. Expected: page now reads warm-dark; links and the accent strip on the existing `intensity-high` rows now appear bone-white instead of red (they'll get fixed properly in Task 3, but should already be neutral). Party-tag chips on her name in the header still show R-red (correct — that's factual data).

Open `site/members/amy-klobuchar.html` in a browser. Expected: same warm-dark feel, party tag shows D-blue (correct).

- [ ] **Step 3: Commit**

```bash
cd ~/.hermes/civiclens
git add render/build.ts
git commit -m "style(render): warm-dark palette, bone-white accent

Replaces partisan-blue accent with bone-white. Party tags keep
their colors as factual labels. Background warmed from #0e1014 to
#14110d, foreground from cool off-white to bone-white #f5f1e8.
Per docs/superpowers/specs/2026-05-10-visual-identity-design.md."
```

---

### Task 2: Add editorial-serif and monospace-numeral typography

**Files:**
- Modify: `render/build.ts` line 176 (the `body` font shorthand) and line 184 (the `h2` rule)

- [ ] **Step 1: Update body font and add heading + numeral stacks**

Find this in `render/build.ts` (line 174):

```css
body {
  margin: 0;
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  background: var(--bg); color: var(--fg);
}
```

Replace with:

```css
body {
  margin: 0;
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  background: var(--bg); color: var(--fg);
  font-feature-settings: 'kern' 1;
}
header h1, h2 {
  font-family: 'Charter', 'Source Serif 4', 'Iowan Old Style', Georgia, serif;
  font-weight: 600;
  letter-spacing: -0.015em;
}
.num, td.num, .tc-asset, .tc-vote-row, .vote-count, .pac-totals, .kv .v {
  font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums;
}
```

Notes:
- `header h1, h2` uses serif system stack — Charter on macOS/iOS, falls through to Georgia elsewhere
- Numerical content uses monospace stack with tabular numerals so dollar columns align
- `.num` already exists in the stylesheet (line 191) for table cells — extending it via the comma-list above means trade-card asset names, vote counts, key-value rows, and PAC totals also pick up the monospace treatment
- `kern` feature for the body sans

- [ ] **Step 2: Rebuild and inspect typography**

Run:

```bash
cd ~/.hermes/civiclens && npx tsx render/build.ts 2>&1 | tail -10
```

Open `site/members/marjorie-taylor-greene.html`. Expected:
- The `<h1>` (member name) and all `<h2>` section headings now render in serif (Charter on Mac, Georgia fallback elsewhere)
- The "Activity at a glance" cells render in monospace with aligned digits
- Trade card asset rows (`.tc-asset`) render in monospace
- Body paragraphs and labels remain in the sans system stack

Open `site/members/amy-klobuchar.html` and confirm the same.

If serif headings look wrong on your platform: the spec accepts the system-stack fallback. Do NOT add a Google Fonts request — that's explicitly out of scope.

- [ ] **Step 3: Commit**

```bash
cd ~/.hermes/civiclens
git add render/build.ts
git commit -m "style(render): editorial serif headings + monospace numerals

System serif stack (Charter → Georgia fallback) on h1/h2 for
editorial weight. Monospace stack with tabular-nums on numeric
content (trade asset rows, glance cells, vote counts, PAC totals).
No network font requests."
```

---

### Task 3: Strip color from intensity classes (weight + density only)

**Files:**
- Modify: `render/build.ts` lines 230–237 (the intensity-class block) and lines 209–211 (the `.suspicion-badge` rules)

- [ ] **Step 1: Replace the intensity-class block**

Find this block in `render/build.ts` (line 230, the comment + three intensity rules):

```css
/* Intensity-mapped rendering — visual weight scales with anomaly substrate
   (committee jurisdiction × proximity × ticker mention). Crude v1: density,
   left-edge accent, asset weight. No text label — the page's voice stays neutral. */
.trade-card.intensity-low    { opacity: 0.78; padding: 8px 12px; }
.trade-card.intensity-low .tc-asset { font-weight: 400; }
.trade-card.intensity-medium { border-left: 3px solid rgba(247,201,72,0.5); padding-left: 12px; }
.trade-card.intensity-high   { border-left: 3px solid #d65a5a; padding-left: 12px; background: rgba(214,90,90,0.03); }
.trade-card.intensity-high .tc-asset { font-weight: 600; }
```

Replace with:

```css
/* Intensity-mapped rendering — weight + density only. No moralizing color.
   Quiet members render quiet pages; loud members render loud pages.
   Per docs/superpowers/specs/2026-05-10-visual-identity-design.md. */
.trade-card.intensity-low    { border-left: 1px solid var(--line);    padding: 6px 12px; }
.trade-card.intensity-low .tc-asset    { font-weight: 400; font-size: 13px; }
.trade-card.intensity-medium { border-left: 2px solid var(--fg-dim);  padding: 10px 14px; padding-left: 12px; }
.trade-card.intensity-medium .tc-asset { font-weight: 500; font-size: 13px; }
.trade-card.intensity-high   { border-left: 3px solid var(--fg);      padding: 12px 16px; padding-left: 13px; }
.trade-card.intensity-high .tc-asset   { font-weight: 600; font-size: 14px; }
```

Notes:
- Removed `opacity: 0.78` from intensity-low (was a holdover from the earlier "fade quiet rows" idea; the spec uses border weight instead)
- Removed all rgba red/yellow tints
- Border-left now scales 1px → 2px → 3px and uses palette variables, not hardcoded color
- Padding scales with intensity (more padding = more visual weight)
- Asset font-weight + font-size also scale (400→500→600, 13px→13px→14px)

- [ ] **Step 2: Replace the `.suspicion-badge` color treatment**

Find this in `render/build.ts` (line 209):

```css
.suspicion-badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 500; }
.suspicion-badge.medium { background: rgba(247,201,72,0.12); color: #f7c948; border: 1px solid rgba(247,201,72,0.4); }
.suspicion-badge.high   { background: rgba(214,90,90,0.12);  color: #d65a5a; border: 1px solid rgba(214,90,90,0.4); }
```

Replace with:

```css
.suspicion-badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 500; border: 1px solid var(--line); color: var(--fg-dim); }
.suspicion-badge.medium { border-color: var(--fg-dim); color: var(--fg); font-weight: 600; }
.suspicion-badge.high   { border-color: var(--fg);     color: var(--fg); font-weight: 700; }
```

Notes:
- Same approach — weight (500/600/700) and border weight differentiate, color stays neutral
- Background tints removed entirely

- [ ] **Step 3: Rebuild and inspect intensity differentiation**

Run:

```bash
cd ~/.hermes/civiclens && npx tsx render/build.ts 2>&1 | tail -10
```

Open `site/members/marjorie-taylor-greene.html`. MTG should have several `intensity-high` trade cards. Expected:
- High-intensity rows: thick (3px) bone-white left border, larger asset name (14px, bold)
- Medium-intensity rows: 2px dim-grey left border, normal-weight asset name
- Low-intensity rows: thin 1px line border, light-weight asset name
- NO red, NO yellow, NO opacity fade
- Differentiation is still visibly clear at a glance — confirm by scanning the trade list

Open `site/members/amy-klobuchar.html` (quieter member). Expected:
- Mostly low/medium intensity rows; the page reads quieter than MTG's
- No card has the bone-white thick border treatment unless she actually has high-intensity hits

If a quiet member's page somehow looks identical to a loud member's, the intensity classifier output may be the issue, not this CSS — flag and stop.

- [ ] **Step 4: Commit**

```bash
cd ~/.hermes/civiclens
git add render/build.ts
git commit -m "style(render): weight-only intensity, strip moralizing color

Removes red/yellow tints from .trade-card.intensity-* and
.suspicion-badge classes. Intensity now differentiates via
left-border weight (1/2/3px), padding, and font-weight + font-size
on the asset name. Quiet members render quiet pages.

Fixes editorial drift from the 2026-05-03 redesign spec where
intensity-high shipped in red against the no-moralizing-color rule."
```

---

### Task 4: Tighten data row rhythm and section spacing

**Files:**
- Modify: `render/build.ts` lines 184 (h2 margin) and 188 (th/td padding)

- [ ] **Step 1: Update vertical rhythm**

Find this in `render/build.ts` (line 184):

```css
h2 { font-size: 17px; margin: 32px 0 12px; letter-spacing: -0.01em; }
```

Replace with:

```css
h2 { font-size: 19px; margin: 48px 0 14px; letter-spacing: -0.01em; }
```

Find this in `render/build.ts` (line 188):

```css
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
```

Replace with:

```css
th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
```

Notes:
- h2 size 17→19px (more presence with the new serif treatment) and section margin 32→48px (more breathing room between sections)
- Data row padding 8→6px (tighter, denser tables)

- [ ] **Step 2: Rebuild and inspect rhythm**

Run:

```bash
cd ~/.hermes/civiclens && npx tsx render/build.ts 2>&1 | tail -10
```

Open `site/members/marjorie-taylor-greene.html`. Expected:
- Section headings (Identity, Activity at a glance, Timeline, Trades & bills, Donors, Outside spending, Co-sponsorship, Patterns detected) feel further apart from one another
- Tables read denser (more rows fit the same vertical space)
- Headings feel weightier with the new serif at 19px

Open `site/members/amy-klobuchar.html` and confirm the same rhythm.

If the page now feels too cramped (rows touching) or too sparse (sections drifting apart awkwardly), tweak ±2px per direction and re-render. Capture the final values you settled on in the commit message.

- [ ] **Step 3: Commit**

```bash
cd ~/.hermes/civiclens
git add render/build.ts
git commit -m "style(render): tighten row rhythm, expand section spacing

Data row padding 8px→6px (denser tables). Section heading margin
32px→48px (more breathing room). h2 17→19px to match the new serif
treatment from the typography pass."
```

---

### Task 5: Final review — render the full roster, sanity check across members

**Files:**
- Read only: `site/members/*.html`

- [ ] **Step 1: Rebuild full site**

Run:

```bash
cd ~/.hermes/civiclens && npx tsx render/build.ts 2>&1 | tail -20
```

Expected: clean build for all 36 members. If any member errors, the visual pass did NOT cause it (no logic changes) — flag separately and continue.

- [ ] **Step 2: Spot-check across the roster**

Open in a browser:

- `site/members/marjorie-taylor-greene.html` (loud — many high-intensity rows)
- `site/members/amy-klobuchar.html` (mid — mixed intensity)
- `site/members/bernie-sanders.html` (quiet on trades — should feel quiet)
- `site/members/dan-crenshaw.html` (loud — confirm differentiation)
- `site/members/alexandria-ocasio-cortez.html` (mid — mixed)

For each, confirm:
- No partisan blue accent on links/borders/headings (only on the D party tag chip if applicable)
- No red except on the R party tag chip
- Serif `<h1>` (member name) and section `<h2>`s
- Monospace tabular numerals in glance cells, asset rows, vote counts
- Visible intensity differentiation between cards (weight + size only)
- Page reads warm-dark, not cool-dark

- [ ] **Step 3: Mobile width check**

Open `site/members/marjorie-taylor-greene.html` in a 375px-wide viewport (Chrome devtools, iPhone SE preset). Expected:
- Body text remains legible (bone-white on warm-charcoal at body size 15px should pass)
- Tables don't horizontal-scroll obviously broken
- Serif heading doesn't break the line awkwardly
- Trade cards stack and remain readable

If any of these fail visibly: file as a follow-up under "Open follow-ups" in the spec — do NOT add layout changes to this pass.

- [ ] **Step 4: Update memory with shipped status**

Add a one-line entry to `~/.claude/projects/-home-captainanime/memory/MEMORY.md` (under existing CivicLens entries) recording that visual identity v1 shipped, referencing the spec path.

The entry should be a single line, e.g.:

```
- [Visual Identity v1 shipped](project_civiclens_visual_v1.md) — bone-white on warm-charcoal, serif heads, mono numerals, weight-only intensity (2026-05-10)
```

And a corresponding short memory file at `~/.claude/projects/-home-captainanime/memory/project_civiclens_visual_v1.md` (one paragraph: what shipped, where the spec lives, confirms editorial drift on red intensity is fixed).

- [ ] **Step 5: Final commit (if any tweaks landed during inspection)**

If Task 5 spot-checking turned up a tweak (e.g., the rhythm needed ±2px adjustment), commit it now:

```bash
cd ~/.hermes/civiclens
git add render/build.ts
git commit -m "style(render): post-review rhythm/typography tweaks"
```

If nothing changed during inspection, skip this step.

---

## Self-Review

Done before handing off:

**Spec coverage check:**
- ✅ Palette (warm-dark inversion) — Task 1
- ✅ Typography (serif heads + monospace numerals) — Task 2
- ✅ Intensity (weight + density only, no color) — Task 3 (both `.trade-card.intensity-*` and `.suspicion-badge`)
- ✅ Density / rhythm — Task 4
- ✅ Party tags keep partisan colors — Task 1 (variables preserved)
- ✅ No new dependencies — confirmed across all tasks
- ✅ No HTML structure changes — confirmed
- ✅ Verification approach — Task 5 covers the rendering side; no test framework on this path is correct per the spec testing section

**Placeholder scan:** No "TBD", "TODO", or vague-handling phrases in the plan steps. All edits show actual before/after code blocks.

**Type consistency:** No types or function signatures introduced — this is a CSS-only pass inside an existing template literal. N/A.
