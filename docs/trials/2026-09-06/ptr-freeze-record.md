# Gate A1 freeze record — House PTR text-layer repair set

**Frozen:** 2026-09-06 · **Approved by:** maintainer · **Assembled by:** Codex
**Status:** AUTHORITATIVE. This is the scope of the Track A PTR repair. It is not
re-derived, and it is not expanded by anything discovered downstream.

## What this record fixes

Nineteen House Periodic Transaction Report filings (`FilingType P`) parsed to zero
rows under the pre-repair extractor and were later loaded with a corrected parser
that recovered the rows but left them semantically dirty — label text embedded in
asset names, and null tickers where the source shows a mixed-case parenthetical.

This record freezes **which filings are in scope** before any code runs, so the
repair cannot quietly grow into a corpus-wide reload. Scope is drawn from the
cached House Clerk index plus the prior audited roster — never from differential
extraction, which serves only as a cross-check (see "Cross-check rule").

## The 19 filings

Five members. All House, all `FilingType P`. All PDF and TXT files verified present
at freeze time.

| # | Year | Filer | DocID |
|---|---|---|---|
| 1 | 2022 | gottheimer-josh | 20020154 |
| 2 | 2022 | gottheimer-josh | 20020393 |
| 3 | 2022 | gottheimer-josh | 20020573 |
| 4 | 2022 | gottheimer-josh | 20021727 |
| 5 | 2022 | frankel-lois | 20020235 |
| 6 | 2022 | frankel-lois | 20020401 |
| 7 | 2022 | frankel-lois | 20020470 |
| 8 | 2022 | frankel-lois | 20020648 |
| 9 | 2024 | frankel-lois | 20025035 |
| 10 | 2022 | pelosi-nancy | 20020208 |
| 11 | 2022 | pelosi-nancy | 20020515 |
| 12 | 2022 | pelosi-nancy | 20020561 |
| 13 | 2022 | pelosi-nancy | 20020662 |
| 14 | 2023 | pelosi-nancy | 20022320 |
| 15 | 2022 | crenshaw-daniel | 20020189 |
| 16 | 2022 | crenshaw-daniel | 20020197 |
| 17 | 2022 | crenshaw-daniel | 20020310 |
| 18 | 2022 | moore-blake | 20020135 |
| 19 | 2022 | moore-blake | 20020344 |

## Source file hashes (sha256)

Cached under `data/caches/pfd-cache/<year>/<filer>-<docid>.{pdf,txt}`.

| Year | Filer | DocID | PDF sha256 | TXT sha256 |
|---|---|---|---|---|
| 2022 | gottheimer-josh | 20020154 | `2fbac108bc999a31171e1ba875091b88646376292b5b581d0e089bcc27f7921c` | `d2c36d66e8c2fa9acea895decba647d5b58721dfa6518ad216425f2f151e0062` |
| 2022 | gottheimer-josh | 20020393 | `785e5e0f6b54324a721ed2f1f29457da3d24a51de62166660ed07f46b7ea63c6` | `d8614105c3c4a76fe3bdf73a2953cc1758db749fbd897b6cdc0ff4adc1f52b87` |
| 2022 | gottheimer-josh | 20020573 | `bde06c80f540bae865253b49f4bda17a317049c8dd67b010435f2dca37aa09fe` | `9bc7209a61ba8fab0d8fbd00bf56c9126257d9f8592f3e80357d202704fa9112` |
| 2022 | gottheimer-josh | 20021727 | `df8e30ae454ab23e6438c1c3db545de49e1191e39f7af43260d87be27e61a6eb` | `2ea273db36ce441d9f6d4755509e2ff3acd201f9cfca14296139f1d778427b5c` |
| 2022 | frankel-lois | 20020235 | `dc9c7a220d16cd31387fb0b1445e2f761700cef0f36dbe1dcb801884b6c00db8` | `436983e0431fa3deed2e6a5ecc859edef591833249fc3ee442e93ea8803b8465` |
| 2022 | frankel-lois | 20020401 | `eb3f1308dcc2f57dbf55d572564c393d29ed8315daf285e359f12676d9ef3b82` | `f90b3d74a7fc5ab7bfddf466ab2f2605918631b441d77def1554360c6774b2f9` |
| 2022 | frankel-lois | 20020470 | `62353358849d7f1c75f0f95575d23ec4370eb2b79396d1e8ddbbddac23abc347` | `2f41ec2b565b0fcc6985baa65b75868082ac72250031f2dd33d0442fb7079b52` |
| 2022 | frankel-lois | 20020648 | `4ef13fdbe0f17eef71728278628aee2c117485316f56807fdc91a0c8c3828de2` | `db3da6402e18983ae8d1dd3899964a7fe2c93ed91e6ab4d8761ed180f712672f` |
| 2024 | frankel-lois | 20025035 | `708af051ae7e2524e99aeb2589e490659778bdea7fa16b2d64a9c7101f3f7a6b` | `ef60e24e01d67d1beb5e54102f34740a726a2e37457d6eeb705db155c82d224d` |
| 2022 | pelosi-nancy | 20020208 | `0bb1b3ead78d79e6d840e6ada537d7abc6ec9964d94298c71da5f58517c4ce9a` | `991fdf43f81de0a87aa5a5daf3587e464cee28f391999b744a5d0084e41b842c` |
| 2022 | pelosi-nancy | 20020515 | `9922a005b14506b313a549c5cf0999b23d99e1d5fe4aea082ff5010a6547f305` | `63ff5e076413190108d4b741dbef160c38e0ceece3762b06e1af65e6b9209098` |
| 2022 | pelosi-nancy | 20020561 | `e4108905643654c0e56772d98163d15cdf09839bd5cb19cf6317b6ae7afe8c34` | `6e97e7e67588a6225bc8b74052b6cfd3202c5149e428f45ccbad0f560a3fcfaa` |
| 2022 | pelosi-nancy | 20020662 | `896607e895aa598d54ac6ccd7583feb7e3c3a7ebdf208e05512fd3375461332d` | `070d2b8cb86979d5610fe477a8e639d6db495c1b7a4291f83116fdf092e26a21` |
| 2023 | pelosi-nancy | 20022320 | `de3388012b20f4402ec5635ec1853c4856046ece1a6fed0a9507babbb44b0e12` | `4ca8dd8b9b35a8f7896f787f64348345cc7154c9451a9e066fd70ae5801a82e8` |
| 2022 | crenshaw-daniel | 20020189 | `cac230646115e1ce40c387a729c51c85d6f2273834e9419fee13c3b0966b16d0` | `1567ea27188f46ab2442e72b8e6198fd77a5d49704f5482de9b625403f4dbd03` |
| 2022 | crenshaw-daniel | 20020197 | `b36f0b318dd54ae40b70b317046a86965d2d58509c35576748c4fa0dea35a318` | `0b0da1982ff6c651b4862065ebcba87db0844cfe5e9ba19b41fead6b48c0b1b7` |
| 2022 | crenshaw-daniel | 20020310 | `476672e3c40695f339b43469f52ca43bc5c4b1d161668a5f1f85d098c9ebc1f0` | `a278750f3841825d8ef0ee342d67dc710881cc789b3c3978a9df445328e2d663` |
| 2022 | moore-blake | 20020135 | `56bda185ed4c0a1d12b3a11f30e7bac9798d1ae2e4adcf37af7e7feaada599b9` | `7f709557c02870e7fadf8868815ec5dff9abc509b23f2a0a77e51b75e2cb8eec` |
| 2022 | moore-blake | 20020344 | `b012d7a45094bbc13f22187088ea4f69c5ce91cf4675914326ab7000100f3791` | `e20ef8bf1c31153c3670e3701bf82667d41cb9b1848c4e9e58297a9a4f342746` |

## Authoritative index hashes

| Index | sha256 |
|---|---|
| `2022FD.xml` | `896eb8c8c59ab4314b83805451608074fea9f9e1e41ab53b9f41f36ed94166f8` |
| `2023FD.xml` | `7b637727cba3832162ee56c390b85c47414a8c2d2ff0b8bde0f1a08cd591ee6d` |
| `2024FD.xml` | `767126b64819ce3f18f806805da983911f1a73644aae87da2e455a01e4421a19` |

## Database state at freeze

| Item | Value |
|---|---|
| `data/civiclens.duckdb` sha256 | `09dc29e36556b6807f4c49a0e5f9a7c9fd12945e8edb6589345f816e2ddaf55e` |
| Write-ahead log | absent (verified) |

The pre-PTR-load backup referenced in earlier session notes **no longer exists** —
a read-only search found no `PREPTR` file under the home directory or `/tmp`. The
current database is therefore the only candidate base. The 417 `fetched_at` values
rewritten during the 2026-09-01 load **stay unchanged**: their historical values
cannot be reconstructed honestly, and those rows genuinely were re-read that day.
They are recorded as an explained rewrite, not as damage to repair.

## Current-database comparison target

| Member | Rows |
|---|---|
| gottheimer-josh | 104 |
| frankel-lois | 64 |
| pelosi-nancy | 14 |
| crenshaw-daniel | 8 |
| moore-blake | 3 |
| **Total** | **193** |

**This allocation is a verification target against the current database only. It is
not ground truth.** These rows were produced by the parser under repair. Where the
allocation and the visible source table in the PDF disagree, **the PDF wins and the
run stops for review.**

## Cross-check rule

Differential extraction (pre-repair parser vs. candidate parser over the same
frozen text files) is a **cross-check, never discovery**. It must reproduce exactly
the 19 filings above. Any additional filing that flips from zero rows to non-zero
is a **hard stop**: it is recorded as a finding and reported, and it is never loaded
under this record.

Label pollution is known to exist in **other** already-loaded filings of the same
`200xxxxx` template era. Those are deliberately out of scope for this round and are
recorded as a standing limitation.

## Stop conditions

The run halts immediately, without proceeding to the next step, on any of:

- a source file hash not matching this record;
- an extracted row count disagreeing with the visible source table;
- an unexpected database difference outside the 19 filings;
- a test failure or a TypeScript error;
- an unrelated artifact difference;
- a differential cross-check that does not reproduce exactly these 19.

## Prohibited under this record

OCR of any kind. Production database mutation. Push. Deploy. Any Track B work. Any
confirmatory computation on the parked timing detectors (`trade-vote-alignment`,
`spousal-trade-timing` — ADR 0003, both `registered`/unconsumed).

## Related

- `docs/trials/2026-09-06/civiclens-completion-plan.md` — the plan this record gates
- `docs/adr/0002-launch-scope-and-descriptive-detector-policy.md` — publication gate
- `docs/adr/0003-preregistered-confirmatory-analysis-policy.md` — detector governance
