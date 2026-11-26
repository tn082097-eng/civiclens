# Senate PTR `verified-empty`: evidence rule (2026-11-26)

A senator has `verified-empty` Senate PTRs for a window only when **all** of the following hold:

1. **Complete chamber-wide index.** EFDS was queried for every PTR submitted in the window with `report_types=[11]` and no name, state or filer-type filter.
   - Every date window is a single page whose distinct filings equal its `recordsTotal`.
   - The windows tile the whole range (`lib/senate-ptr-index.ts`).
   - Any short page, repeated row, row outside its window, non-PTR row, or empty index rejects the index.
2. **No surname match.** No filing in that index shares a surname token with the member's official identity.
   - Tokens come from congress-legislators `name.last` plus the last word of `official_full`, lowercased, with particles and suffixes removed.
   - Each filing is matched on its last-name column and on the office name before the comma.
   - Electronic and paper PTRs both count.
   - First names are never used to rule a filing out.
3. **A re-checked certificate.** The fetcher writes `_search-receipts/<bioguide>.empty.json`, which cites `_chamber-index/<from>-<to>-<sha16>.json`. Every time the loader reads the certificate, it:
   - re-hashes the stored index,
   - re-checks its window tiling,
   - re-derives the member's surname tokens from the pinned identity,
   - and re-runs the match.

   If a cached filing resolves to the member, or a filing receipt exists alongside the certificate, the loader refuses before any write.

A zero-result name search never certifies anything. Any surname match blocks the certificate, even one that belongs to a different senator. The result is then `failed` and needs review. It is never `verified-empty`.

## Why

EFDS name search matches the recorded first/last name exactly. It stores Collins as `Susan M` (no period), so the display-name query `Susan M.` / `Collins` returned 0 rows although she had 3 PTRs. Only a name-free listing removes that dependency. It is the Senate counterpart of the House Clerk annual index.

## Source behavior (frozen: `fixtures/senate-ptr/efds-index-2026-11-26/`)

- The bracketed `report_types[]=11` / `filer_types[]=1` form that the name search sends is **ignored**.
  - A Collins query returned her Annual Report.
  - An unfiltered 2026 window returned 516 annual, candidate, extension-notice and paper rows.
- `report_types=[11]` (the form the EFDS page uses) restricts results to PTRs.
- A page holds at most 100 rows. The paging order is not shown to be stable, so windows are never paged.
- Paper PTRs appear as `/search/view/paper/<id>/` with uppercase names and office `Senator`.

## Live check (2026-11-26, scratch cache; report in `artifacts/2026-11-26-senate-empty-rule/live-check.json`)

- **Index.** 2023–2026 holds 559 PTRs (500 electronic, 59 paper) in 8 single-page windows; sha256 `09ac72ce9dcb4be0…`.
- **Chris Van Hollen (V000128).** The name search found 0, and the index has no filing under `hollen`. He is now `verified-empty` on this evidence. This replaces the archived zero-filing receipt, which the 2026-11-26 receipt rule rejects.
- **Roster senators, 2026.** For Collins, McConnell, Wyden and Whitehouse, the index filings under each surname equal their existing receipts exactly (3, 4, 1 and 10).

## Known gap (not fixed here)

The name-search fetcher (`skills/senate-ptr/fetch.ts`) keeps only `/search/view/ptr/` links, so it drops paper PTRs.
- The 2023–2026 index has 59 paper PTRs, from Blumenthal, Boozman and Fetterman.
- None of them is on the roster.
- A senator who files on paper would get a receipt that omits those filings. Fixing this needs a supported paper-PTR path (the filings are scanned images), which is a separate decision.
