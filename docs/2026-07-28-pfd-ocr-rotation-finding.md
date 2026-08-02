# The scanned PTRs aren't unreadable — they're rotated 90°

*2026-07-28. Empirical probe, no code changed.*

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

Even with clean rotation, the OCR text still needs to survive
`extractPTR_OCR()` (`extract.ts:104-240`), the psm-6 pipe-grid parser. Readable
headers do **not** guarantee parseable transaction rows. Byte count and keyword
hits are a proxy for "OCR is working", not for "transactions extracted".

## Recommended sequence (not yet done)

1. Per-page orientation via `tesseract --psm 0`, rotate by the reported angle,
   OCR. Generalized — no member-specific handling.
2. Re-probe the three zero-byte mccaul files to find out whether orientation
   explains them.
3. Only then decide whether `extractPTR_OCR` can parse the result. If rotated
   OCR still yields 0 transactions, *that* is when "needs commercial OCR" is a
   supported conclusion — and this document should be updated to say so.
4. Separately, the OCR trigger at `extract.ts:467` (`!text.trim()`) still misses
   the 51–83 byte junk-text files. That is an independent bug from the rotation
   issue and needs its own fix.

## Environment

poppler 24.02.0 (`pdftoppm`, `pdfimages`, `pdfinfo`, `pdffonts`), tesseract
5.3.4 / leptonica 1.82.0, Python PIL available. **ImageMagick `convert` is NOT
installed** — the probes used PIL for rotation, so any implementation should use
PIL (or tesseract's own orientation handling) rather than shelling out to
ImageMagick.
