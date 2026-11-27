# House PTR seat identity (2026-11-26)

The House Clerk index often records a member's legal first name where the pinned congress-legislators identity records a short name. One example is "Daniel" for C001120, whose pinned `name.first` is "Dan" with no nickname.

Before this change, the House loader (`db/load-pfd.ts`) treated a same-seat, same-surname PTR with an unmatched first name as an ambiguous identity. The rule was correct to fail closed, but it held real filings.

## Rule

A House index PTR (`FilingType` P) belongs to the target member when:

1. its `Year` is the load year;
2. its `StateDst` is a seat the target held in that year;
3. its surname matches the target's pinned surname; and
4. one of the following holds:
   - **Name match.** Its first name matches the pinned `first` or `nickname`. This is unchanged.
   - **Seat identity.** The hash-pinned identity snapshot (the current pin in `lib/official-identity.ts`, via `houseSeatHolders`; `as_of` 2026-11-26 since the re-capture) lists the target as the **only** holder of that seat from January 1 of the record's year through its `FilingDate`.

A record accepted by seat identity also needs an extracted filing that names a `Member` for the same seat. It must also resolve to the target with confidence 1.

If any part of this fails, the record stays ambiguous and the loader refuses. That covers:
- a second seat holder in the span, such as a new Congress starting on January 3;
- a missing or unparseable filing date, or one outside the record's year;
- a date outside the pin's `[2019-01-03, as_of]` window;
- an extracted filing with a different status or seat.

Seat identity never produces `verified-empty`. A seat-matched PTR that hasn't been extracted fails as "not extracted".

The surname requirement stays. The 2023 index has a PR00 PTR from Ada Norah Henriquez, who is not the seat's member. It is not attributed to anyone.

## Evidence

**Survey.** I compared the 2023–2026 House indexes with the pinned snapshot. Index files:
- 2023–2025 from `civiclens-track-b-trials/closeout-2026-09-14-inputs`;
- 2026: `artifacts/2026-11-24-roster-freshness/house-ptr-staging-cache/index/2026FD.xml`.

Results:
- 1,874 PTRs have exactly one same-surname seat holder.
- 184 of them, from 21 members, have a first name the pinned identity doesn't list. Examples: Rick Allen ("Richard W."), Ro Khanna ("Rohit"), Jim Jordan ("James D"), Crenshaw ("Daniel").
- No PTR has two same-surname holders.
- The seat rule accepts 145 of the 184, from 19 members.
- The other 39, from 7 members, stay held: the seat changed hands in the span (mostly new Congresses on January 3), or the filing date is outside the record's year.

**Replay.** C001120 filing 20035024 was replayed into a fresh copy of the 2026-11-26 scratch rebuild. Report: `artifacts/2026-11-26-crenshaw-seat-identity/replay-report.json`. Inputs:
- the PDF sha256 matches its receipt;
- the supported parser reproduces the cached JSON exactly;
- the filing names "Hon. Daniel Crenshaw", Member, TX02, with 8 rows.

Results:
- Only `pfd_transactions` changed.
- 8 rows were added.
- Crenshaw's 16 existing rows and every other member's rows are unchanged.
- The launch DB hash is unchanged.

## Known gap (not fixed here)

The surname check compares the index `Last` with the **first token** of the pinned `name.last`. The survey found PTRs from these members that it misses:
- McMorris Rodgers ("Rodgers")
- Barragán ("Barragan")
- Luna ("Paulina Luna")
- McClain Delaney ("Delaney")
- Sánchez ("Sanchez")
- McCormick, who filed under GA06 while holding another seat

None of these members is on the roster. For such a member, the index proof finds no target PTRs. With no extracted filings, the loader would then report `verified-empty` falsely. Fixing it needs a separately approved change to surname normalization and matching.
