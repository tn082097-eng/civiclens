<!--
  Provenance: external adversarial critique of the XSS-hardening patch (safeJson) for render/build.ts,
  produced by Grok (xAI) in its critic-only role during the 2026-06-05 XSS pilot.
  Generated read-only via `grok --permission-mode plan` (plan mode forbids edits) — which is exactly
  why Grok could not write this file itself at the time; this is its captured stdout, verbatim below.
  Raw output: ~/grok-workspace/runs/critique-r0.md
  Line numbers below refer to the pilot-branch snapshot of render/build.ts on 2026-06-05, NOT current
  main — verify against the live file before acting. These are Grok's opinions, not verified facts.
-->

# CivicLens — XSS Hardening Critique (Grok, critic-only)

> External adversarial-but-fair review of the `safeJson()` patch for `render/build.ts`, by Grok
> (read-only), 2026-06-05. Grok did not write this patch and could not modify the tree; the captured
> stdout follows verbatim. File/line references are Grok's and reflect the pilot snapshot — verify
> before acting.

Reviewing the patch skeptically: reading the diff and scanning `render/build.ts` for all JSON-in-script embeds.
## Criteria verdicts

| # | Criterion | Verdict |
|---|-----------|---------|
| 1 | Escaping correctness | **PASS** |
| 2 | Completeness (other `JSON.stringify` in `<script>`) | **PASS** |
| 3 | Behavior preservation | **PASS** |
| 4 | Rewritten comment (~1569–1571) | **CONCERN** (minor inaccuracy; stale line above) |
| 5 | Fence / scope | **PASS** |

### 1. Escaping correctness — **PASS**

```52:58:render/build.ts
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
```

All five targets are escaped on the **serialized** string after `JSON.stringify`. Order is correct (stringify first, then byte-level escapes).

- `</script>`: `<` becomes `\u003c` in the HTML source, so the tokenizer never sees a literal `</script>` (e.g. `"\u003c/script>"` in the file).
- `]]>`: irrelevant inside `<script>` (CDATA-only); escaping `>` is harmless extra defense, not under-escaping.
- U+2028/U+2029: literal code units in output are rewritten to `\u2028`/`\u2029` text; if `JSON.stringify` already emitted those six-character escapes, the regex does not match and there is no double-escape.
- Parsed/runtime values: `\u003c` etc. in JSON/JS string literals decode to the same characters as before; no semantic change to object contents.

No blocking under- or over-escaping found for the stated threat model.

### 2. Completeness — **PASS**

`grep` shows the only `JSON.stringify` in `render/build.ts` is inside `safeJson` (line 53). Dynamic payloads embedded in inline scripts:

| Site | Line | Wrapped |
|------|------|---------|
| `DATA` | 750 / 765 | `safeJson` |
| `GRAPH` | 1567 / 1574 | `safeJson` |
| `NEXUS` | 1802 / 1817 | `safeJson` |
| `THEME` | 1818 | `safeJson` |

Other `<script>` blocks (551, 1523, 763 shell, etc.) are static or use `${dataJson}` / `${graphJson}` / `${nexusJson}` only through those variables. No missed `JSON.stringify` embeds.

### 3. Behavior preservation — **PASS**

Consumption is **JS literal assignment**, not `JSON.parse()`:

```1574:1574:render/build.ts
  const GRAPH = ${graphJson};
```

(same pattern for `DATA`, `NEXUS`, `THEME`). JSON is a valid JS expression subset; `\uXXXX` in literals yields the same runtime strings/objects as unescaped JSON would.

Client code uses property access, comparisons on enums (`'yea'`, `'rel'`, etc.), and `escHtml()` before DOM HTML — no raw matching on serialized escape sequences. `THEME[d.theme]` uses runtime keys from loop data, not the escaped wire form.

### 4. Comment accuracy — **CONCERN**

**Rewritten block (1569–1571):** Mostly right about `escHtml()`, `safeJson()`, and the five escapes. Small slip: it says “JSON.parse()-ing” but nothing calls `JSON.parse`; the engine evaluates a literal. Semantics match `JSON.parse` for JSON text, so this is comment precision only, not a runtime bug.

**Stale line still present (1566):**

```1566:1567:render/build.ts
  // Serialize to JSON — all string values from DB, safe for embedding in <script>
  const graphJson = safeJson({ nodes, edges });
```

That line still claims DB-origin strings are “safe for embedding” without mentioning `safeJson`, and contradicts the new comment. Not a fence violation; worth fixing for accuracy.

### 5. Fence — **PASS**

Diff is limited to: `safeJson` (52–59), four call sites (750, 1567, 1802, 1818), and the comment swap (1569–1571). No new files, no unrelated refactors.

---

## Prioritized findings

### Blocking issues
**None.** For the stated goal (harden JSON-in-`<script>` without changing parsed data), the patch looks correct and complete.

### Concerns (non-blocking)
1. **Comment precision (1569–1571):** Says `JSON.parse()`; actual mechanism is literal evaluation (`const GRAPH = …`). Behavior is fine; wording is slightly off.
2. **Stale comment (1566):** Still asserts DB strings are “safe for embedding in `<script>`” with no mention of `safeJson` — misleading next to the hardened line.

### No action needed
- All five escape targets implemented; `</script>` breakout and U+2028/U+2029 script hazards addressed for these embeds.
- All four dynamic JSON-in-script sites routed through `safeJson`; no other `JSON.stringify` embeds in this file.
- Client graph/timeline/nexus logic should behave identically at runtime.
- Patch stayed in scope.

**Bottom line:** Approve from an adversarial review perspective; optional follow-up is comment cleanup only (1566 + “JSON.parse” wording), not code changes.
