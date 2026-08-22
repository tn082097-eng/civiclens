# The scanned PTRs aren't unreadable — they're rotated

*2026-07-28. Empirical probe, no code changed.*

> [!warning] SUPERSEDED IN PART — corrected 2026-08-17
> The core insight below is right: **the scans are rotated, and rotation is the
> variable that matters.** Two specifics are now measured wrong. Read this box
> before acting on anything further down.
>
> 1. **There is no single correct angle.** This document's "+90 for everything"
>    does not hold. Measured angles, by member and page shape:
>
>    | corpus | page shape | correct rotation |
>    |---|---|---|
>    | Khanna | portrait | ~~**270°**~~ **WITHDRAWN 2026-08-21 — see box below** |
>    | McCaul | portrait | **90°** |
>    | McCaul | landscape | **0°** (none) |
>
>    Khanna is 270°, i.e. **−90 — the direction this document explicitly warns
>    against.** The byte counts here were right; the naming of the direction was
>    not. See `2026-08-10` probe in `~/.claude/plans/snazzy-drifting-mitten.md`.
>
>    > [!caution] The `Khanna portrait = 270°` row is WITHDRAWN (2026-08-21)
>    > It did not reproduce. Re-measured on four Khanna filings across two
>    > filing years — **all four resolve to 90°, none to 270°**:
>    >
>    > | filing | page | native size | resolved | evidence at 270° |
>    > |---|---|---|---|---|
>    > | `2025/khanna-rohit-9115671.pdf` | 2 | 1683×2170 | **90°** | 0 keywords, 839 B |
>    > | `2022/khanna-rohit-8218518.pdf` | 2 | 1672×2168 | **90°** | unreadable runs |
>    > | `2022/khanna-rohit-8218597.pdf` | 2 | 1673×2171 | **90°** | 0 keywords |
>    > | `2022/khanna-rohit-8218940.pdf` | 2 | 1694×2182 | **90°** | `waroniva` (mirrored) |
>    >
>    > At 90° each page yields a legible `NAME: Ro…Khanna` header
>    > (`Wnt: Rohinithenns`, `NAME: RohRthenna`, `WANE: Redttthanns`); at 270°
>    > the same pages yield mirrored text. The 270° figure appears to derive
>    > from a single earlier probe on one file and does not generalize.
>    >
>    > **This row is NOT replaced by a `Khanna portrait = 90°` rule.** A
>    > member-level rotation rule is the wrong shape of claim regardless of which
>    > angle it names — see the box below.
>
> 2. **Orientation is a property of the page, not the file.** Do not branch on
>    `pdfinfo` page size. `2025/mccaul-michael-t-8221263.pdf` and others are
>    uniform, but `2025/mccaul-michael-t-8221228.pdf` reports portrait page size
>    while containing a portrait cover page (1696×2200) followed by **landscape**
>    data pages (2200×1696). Branch on each rasterized page's pixel dimensions.
>
> 2b. **No member-level rotation rule is valid — orientation must be detected
>    and recorded per page.** (Added 2026-08-21, replacing the withdrawn Khanna
>    row above.) The durable rule is:
>
>    - **Detect** the angle for **each rasterized page image** independently, by
>      header-keyword legibility, with an explicit **mirrored-text check**. Never
>      by member, never by file, never by `pdfinfo` page size.
>    - **Record** the angle actually applied alongside every value extracted from
>      that page, so a later session can reconcile a result without re-deriving
>      it. The absence of this record is what made the two 2026-08-20 sessions
>      irreconcilable.
>    - **Byte count must never be the acceptance test.** Measured on
>      `2025/mccaul-michael-t-9115664.pdf` page 2: the *mirrored* 270° output
>      scored **2205 B** against the *correct* 90° output's **1931 B**. The wrong
>      angle produced more text.
>
>    Supporting measurement — every portrait data page across three McCaul
>    filings (`2025/9115664`, `2025/9115677`, `2024/8220214`; 20 page-images)
>    selects 90° on keyword score, and none selects 270°. That is a strong result
>    **for McCaul portrait pages** and is silent about every other stratum. It is
>    recorded as evidence, not promoted to a rule.
>
>    Full reconciliation, with per-measurement page identities, orientation,
>    cell coordinates, OCR configuration, and ground-truth provenance:
>    `NoService/Projects/CivicLens/2026-08-21 OCR session reconciliation.md`
>    (measurements M2, M3, M9; withdrawn claims W1, W6).
>
> 3. **Do NOT use `--psm 0` OSD to pick the angle** (contra "Recommended
>    sequence" step 1 below). Measured unreliable on this bilevel corpus: one
>    page reports 180°/"Cyrillic" at 0.20 confidence. Decide from page pixel
>    dimensions, then **validate by keyword presence**
>    (`Periodic Transaction Report`, `FULL ASSET NAME`, `AMOUNT OF TRANSACTION`).
>    Byte count does **not** separate correct from mirrored output.
>
> **The open question in "Not yet solved" is now answered.** The three
> zero-byte mccaul files were **landscape pages being rotated +90**. Orientation
> explains them exactly, as that section suspected.
>
> Rotation alone is still **not sufficient** — it recovers text but not the
> purchase/sale checkbox column. See
> `NoService/Projects/CivicLens/2026-08-16 McCaul validation — Task 1 result.md`.
> **`extract.ts:482` remains correct and must stay** until verified transactions exist.

## Summary

`skills/pfd-fetcher/extract.ts:482` logs *"scanned table — needs commercial OCR"*
and discards the result whenever OCR yields 0 transactions. That conclusion is
**wrong, or at least premature**: the scans are **rotated 90°**, and tesseract
was being asked to read a sideways table. Rotating the page before OCR turns
noise into readable text with no other change.

This matters for `ro-khanna` (58 PDFs, 52 PTRs in the House Clerk index) and
`michael-mccaul` (55 PDFs), currently contributing 1 and 0 loaded filings.

## Evidence

Test file: `data/caches/pfd-cache/2024/khanna-rohit-8220626.pdf` (39 pages).

**Tesseract itself reports the rotation.** `tesseract <img> - --psm 0`:

```
Orientation in degrees: 270
Rotate: 90
Orientation confidence: 0.82
```

**Before rotation** — 337 bytes of noise:

```
Te 7 EDS
ze ge a
PW) oo |e b ! a
gogo j= li
```

**After `rotate(90, expand=True)`** — 1,089 bytes, readable:

```
Periodic Transaction Report
FULL ASSET NAME | TYPE OF | DATE | DATE NOTIFIED | AMOUNT OF TRANSACTION
U.S. House of Representatives
```

Page 2 (a data page rather than the cover sheet) went to 1,420 bytes with
`Date of Transaction` / `Transaction Type` column headers resolving.

**Direction matters — it is +90, not −90.** At `-90` the output is mirrored
(`dX3 OTZ Wd OWNS X37J Id¥v/TVS` is `SAL/AAPL FLEX ...` reversed) and only 541
bytes. Rotating the wrong way looks *almost* plausible and silently produces
garbage, so this is worth pinning in code with a comment.

> **CORRECTION (2026-08-17).** The *warning* in this paragraph is the durable
> lesson and it is correct — wrong-direction output is mirrored, plausible, and
> silent. The *direction claim is not*. Re-measured on this same file, all four
> angles scored by keyword presence: **270° is the correct angle for Khanna**,
> yielding `Poriodic Transaction Report` / `NAME: Rohit Khanna` / `FULL ASSET
> NAME`. **270° is −90** — the case this paragraph rules out. At +90 the text is
> the mirrored garbage (`NOLLOVSNVUL 4O LNNORY`). Byte counts here were close
> enough to be indistinguishable (1071 B at 90 vs 1131 B at 270), which is
> exactly why byte count must not be the acceptance test. McCaul portrait pages
> want +90; McCaul landscape pages want 0°. **There is no single angle to pin.**
>
> > **NARROWED (2026-08-21).** The byte-count lesson above stands and is the
> > durable part. The generalization **"270° is the correct angle for Khanna"**
> > does **not** — it is withdrawn as a member-level rule. Four Khanna filings
> > across 2022 and 2025 were re-measured and **all four resolve to 90°**
> > (see the withdrawal box at the top of this document). Whatever this single
> > file does, it is a **page-level** observation and must be recorded as one;
> > it does not license a rule about "Khanna". Detect and record orientation
> > per page.

## Why the earlier attempt failed, and why more DPI made it worse

The scans are **1-bit CCITT fax-encoded** images at 200 ppi native:

```
pdfimages -list:  1679x2168  gray  comp 1  bpc 1  enc ccitt  200x200 ppi
pdffonts:         (empty — no text layer at all)
```

`ocrPdf` (`extract.ts:83`) rasterizes with `pdftoppm -r 250`, upsampling a
bilevel fax image — inventing resolution that isn't in the source and adding
interpolation artifacts. Probes confirm the direction of the effect:

| approach | bytes | readable? |
|---|---|---|
| `-r 250`, no rotation (current code) | 337 | no |
| `-r 400`, psm 6 | 386 | no |
| `-r 400`, psm 4 | **0** | no |
| `-r 400`, psm 11 | 341 | no |
| native-res via `pdfimages`, psm 6 | 366 | no |
| **`-r 200` + rotate 90, psm 6** | **1,089–1,420** | **yes** |

So: raising DPI and switching `--psm` are both dead ends. **Rotation is the
variable that mattered**, and none of the prior tuning would ever have found it.

## Not yet solved — do not assume this is a finished fix

A spot check across other files gives **mixed** results:

| file | bytes after rotation | keyword hits |
|---|---|---|
| `khanna-rohit-8220451` | 1,264 | 3 |
| `mccaul-michael-t-8218545` | 1,250 | 1 |
| `mccaul-michael-t-8218579` | 1,340 | 3 |
| `mccaul-michael-t-8218615` | **0** | 0 |
| `mccaul-michael-t-8218645` | **0** | 0 |
| `mccaul-michael-t-8218855` | **0** | 0 |

Three mccaul files produce **nothing** after a +90 rotation. Likely causes, in
order of suspicion: a different per-file (or per-page) orientation; pages that
are not scans at all; or a rasterization failure. **Per-page orientation
detection via `--psm 0` is the obvious next step** rather than a hardcoded +90 —
tesseract already reports the angle, so the pipeline should ask instead of
assume.

> **ANSWERED (2026-08-17).** First suspicion was right: **different page
> orientation.** Those files are landscape scans (2200×1696 or 2169×1682); at
> +90 they are rotated into garbage. They need **0°**. All 25 cached McCaul PDFs
> were re-measured at all four angles — every one resolved unambiguously
> (winning angle 3/3 keywords, others 0–1): landscape ⇒ 0°, portrait ⇒ 90°.
>
> **But do not adopt the `--psm 0` recommendation.** OSD is unreliable on this
> bilevel corpus (a page reporting 180°/"Cyrillic" at 0.20 confidence), so asking
> tesseract would rotate the wrong way. Decide from page pixel dimensions and
> validate by keyword presence instead.

Even with clean rotation, the OCR text still needs to survive
`extractPTR_OCR()` (`extract.ts:155`, as of 2026-08-17), the psm-6 pipe-grid parser. Readable
headers do **not** guarantee parseable transaction rows. Byte count and keyword
hits are a proxy for "OCR is working", not for "transactions extracted".

## Recommended sequence (not yet done)

1. ~~Per-page orientation via `tesseract --psm 0`, rotate by the reported angle,
   OCR.~~ **SUPERSEDED — OSD is unreliable here.** Use per-page pixel dimensions
   to choose the angle, then validate by keyword presence. Still generalized —
   no member-specific handling.
2. ~~Re-probe the three zero-byte mccaul files.~~ **DONE 2026-08-17 — orientation
   explains them; they are landscape and need 0°.**
3. Only then decide whether `extractPTR_OCR` can parse the result. If rotated
   OCR still yields 0 transactions, *that* is when "needs commercial OCR" is a
   supported conclusion — and this document should be updated to say so.
4. Separately, the OCR trigger at `extract.ts:468` (`!text.trim()`) still misses
   the 51–83 byte junk-text files. That is an independent bug from the rotation
   issue and needs its own fix.

## Environment

poppler 24.02.0 (`pdftoppm`, `pdfimages`, `pdfinfo`, `pdffonts`), tesseract
5.3.4 / leptonica 1.82.0, Python PIL available. **ImageMagick `convert` is NOT
installed** — the probes used PIL for rotation, so any implementation should use
PIL (or tesseract's own orientation handling) rather than shelling out to
ImageMagick.
