# W3 identity/snapshot audit (read-only)

Candidate: e3eb78956c36f1a4a275a8907d2f01f10f2ce6ba. Window 2022-10-21..2026-10-21 inclusive. Offline only; no repo edits; no network; no DB.

## Verdict

**SUPPORTABLE.** The frozen snapshot supports the proposed targets: House H001047 and A000370 (reference H001047), Senate S000033 and W000817 (reference S000033). All four have continuous in-service coverage of their chamber for every day in the window (0 uncovered days each). The snapshot hash matches the pin. No Senate in-window person lacks an LIS id, and there are no duplicate LIS ids.

The risk for a full-window census is not the four targets. It is (a) mid-window departures and arrivals and (b) members sworn in after the snapshot's unknown source date. Either one fails the whole roll, not just one voter (see Failure modes).

## 1. Snapshot integrity and contract

- `sha256sum fixtures/votes/identity/legislators-d5af3d2-voting-terms.json` = `582e5b3e825b54b323c7720cac0f39d6d92e42baf1c009ccb78702a863ac9fe8`. This equals `IDENTITY_SNAPSHOT_SHA256` in `lib/official-identity.ts`. **Match.**
- Top-level keys: `contract` = `"civiclens.official-vote-identity"`, `version` = 1, `floor` = `"2019-01-03"`, `source.commit` = `d5af3d2d2490f8c6532c9490b1f47a76cacca699` (CC0-1.0), `source.inputs[]` (current yaml 1,081,187 bytes; historical yaml 8,997,407 bytes, each with sha256 and URL), `exclusion`, `people`.
- 895 people, 2,491 terms. Each person has `bioguide`, `lis` (string or null), `terms[{chamber, start, end, state, district}]`. These counts match `fixtures/votes/identity/README.md`.
- Not verified: the derivation script `tools/congress-collector/derive_identity.ts` was not audited line by line. The derivation inputs live in `artifacts/govtrack-replacement-2026-10-16-0907/`, which is **absent from this worktree** (`ls` failed). The fixture therefore cannot be re-derived here; only the pinned hash can be checked.

## 2. Target table

Coverage check: each day from 2022-10-21 to 2026-10-21 was tested with `t.start <= d <= t.end` (inclusive, as in `serves()`). Consecutive terms share a boundary date (for example 2023-01-03 is the end of one term and the start of the next). Both terms serve that day, so there is no gap.

| Target | Chamber | State/district | LIS | All terms in snapshot | Uncovered window days | Verdict |
|---|---|---|---|---|---|---|
| H001047 (ref) | house | CT-4 | null | 2017-01-03→2019-01-03; 2019→2021; 2021→2023; 2023→2025; 2025→2027-01-03 | 0 | SUITABLE |
| A000370 | house | NC-12 | null | 2017→2019; 2019→2021; 2021→2023; 2023→2025; 2025→2027 | 0 | SUITABLE |
| S000033 (ref) | senate | VT | S313 | 2013→2019; 2019→2025; 2025→2031 | 0 | SUITABLE |
| W000817 | senate | MA | S366 | 2013→2019; 2019→2025; 2025→2031 | 0 | SUITABLE |

Each target has terms in one chamber only (H001047 and A000370 have no senate terms; S000033 and W000817 have no house terms). Because `serves()` is chamber-specific, the other chamber's terms cannot cause a false pass.

No alternative is needed; all four targets pass.

## 3. Freshness

- Latest term start in the snapshot: **2026-09-02** (W000832, House CA-14). The snapshot therefore includes swearing-ins through early September 2026.
- Upstream commit d5af3d2 is **not in the local object store** (`git cat-file -t` failed). Its date cannot be checked offline. The repo's own commit a896010 is dated 2026-10-20, but that is the repo commit, not the upstream date. The derivation README gives no date.
- Consequence: any member sworn in after the (unknown) source date is absent, so their roll votes would give `unmapped_voter`.

Terms starting after 2026-06-01 (all four are inside the window):

| bioguide | lis | chamber/state/district | start | end |
|---|---|---|---|---|
| G000607 | null | house CA-1 | 2026-06-10 | 2027-01-03 |
| B001328 | null | house GA-13 | 2026-09-01 | 2027-01-03 |
| W000832 | null | house CA-14 | 2026-09-02 | 2027-01-03 |
| G000608 | S441 | senate SC | 2026-07-14 | 2027-01-03 |

Chamber departures: last term in a chamber ends strictly inside the window. There are **147** Jan-3 expirations (normal term ends) and **40** mid-window ends. The 40 are listed below as `bioguide chamber state district/LIS end`. Any roll after such an end that records the person with a position other than "Not Voting" fails `voter_not_in_service`.

- House (31): A000377 ND 0 2024-12-14; B001251 NC 1 2022-12-30; B001297 CO 4 2024-03-22; C001078 VA 11 2025-05-21; C001084 RI 1 2023-05-31; C001127 FL 20 2026-04-21; D000482 PA 18 2022-12-31; G000551 AZ 7 2025-03-13; G000578 FL 1 2024-11-13; G000579 WI 8 2024-04-24; G000590 TN 7 2025-07-21; G000594 TX 23 2026-04-14; G000596 GA 14 2026-01-05; H001038 NY 26 2024-02-02; J000032 TX 18 2024-07-19; J000292 OH 6 2024-01-21; J000308 NC 14 2024-12-31; K000394 NJ 3 2024-12-08; L000578 CA 1 2026-01-05; M001165 CA 20 2023-12-31; M001200 VA 4 2022-11-28; P000096 NJ 9 2024-08-21; P000604 NJ 10 2024-04-24; S001150 CA 30 2024-12-08; S001157 GA 13 2026-04-21; S001192 UT 2 2023-09-15; S001193 CA 14 2026-04-14; S001207 NJ 11 2025-11-20; S001222 NY 3 2023-12-01; T000489 TX 18 2025-03-04; W000823 FL 6 2025-01-20.
- Senate (9): B001320 CA S424 2024-12-08; F000062 CA S221 2023-09-28; G000359 SC S293 **2026-07-11**; H001097 NJ S425 2024-12-08; M000639 NJ S306 2024-08-20; M001190 OK S419 2026-03-23; R000595 FL S350 2025-01-20; S001197 NE S382 2023-01-08; V000137 OH S421 2025-01-09.

Total mid-window: 31 House + 9 Senate = 40. Jan-3 expirations are excluded from this list.

Unusual end dates to check against the actual last vote:
- G000359 (Senate SC, S293) ends 2026-07-11. G000608 (Senate SC, S441) starts 2026-07-14. This looks like a seat handover with a 3-day gap in the snapshot, so verify this is a real vacancy, not a data error. It is the only Senate case in which the new start is later than the old end by days.
- M001190 (Senate OK, S419) ends 2026-03-23.
- Resignations and expulsions (ends not on Jan 3) are plausible as recorded. S001222 ends 2023-12-01, which matches the expulsion date.

Boundary semantics: at 2023-01-03 and 2025-01-03, outgoing and incoming terms both serve (inclusive). A roll on the boundary date does not fail. No check found a conflict.

## 4. Senate LIS mapping

- Senate in-window people (any senate term overlapping the window): **126**. People with a null `lis` among them: **0**. The same holds across all Senate-term people (0 null).
- Duplicate LIS ids: **none** across 145 distinct LIS values (`byLis` would throw on a duplicate).
- `lis` is set only for people with senate terms.
- VP: the snapshot has no VP entry (every bioguide matches `^[A-Z]\d{6}$`). The collector check (`lib/collector-bridge.ts:70`) and the normalizer (`skills/researcher/official-member-votes.ts:144`) skip the literal string `'VP'`. The skip happens before identity, so a VP tie-break entry never reaches `personForVoter`. No frozen Senate XML contains a VP entry, so this path is untested here.

## 5. Frozen official XML fixtures mapped offline

Method: parse House `<legislator name-id>` and `<vote>`, or Senate `<member>` `<lis_member_id>` and `<vote_cast>`. Date comes from `<action-date>` (House) or `<vote_date>` (Senate). Each voter is checked with `serves()`. Non-"Not Voting" failures are counted as failures, and "Not Voting" out-of-service is noted as retained (matches `analyzeRoll`).

| File | Chamber | Date | Voters | Result |
|---|---|---|---|---|
| fixtures/votes/official-samples/house-bill-2025-roll006.xml | house | 2025-01-07 | 434 | all ok |
| fixtures/votes/official-samples/house-speaker-2025-roll002.xml | house | 2025-01-03 | 434 | all ok |
| fixtures/votes/house-acquisition/house-2025-roll001.xml | house | 2025-01-03 | 435 | 434 ok; **1 out-of-service "Not Voting" (G000578, term ended 2024-11-13) retained** |
| fixtures/votes/official-samples/senate-119-1-roll00001.xml | senate | 2025-01-09 | 99 | all ok |
| fixtures/votes/official-samples/senate-amendment-119-1-roll00003.xml | senate | 2025-01-15 | 99 | all ok |
| fixtures/votes/official-samples/senate-bill-119-1-roll00570.xml | senate | 2025-10-09 | 100 | all ok |
| fixtures/votes/official-samples/senate-nomination-119-1-roll00655.xml | senate | 2025-12-18 | 100 | all ok |

**Unmapped IDs: 0** across all 7 files. One out-of-service listing (G000578) follows the intended "Not Voting" retention path.

Not run: `skills/researcher/sources/govtrack-vote_voter-sample.json` (not official XML) and `fixtures/votes/collector-output/bridge-run-official-samples.json`. The XML check covers the frozen official fixtures the task asked for.

## 6. Expected failure modes (ranked by likelihood in a full-window census)

1. **voter_not_in_service on mid-window transitions.** The 40 mid-window departures above, and any in-window arrival whose term starts after a roll that records them with a non-"Not Voting" position. Impact: one failed roll per occurrence. Likelihood: high, because the census spans four years with many special elections and resignations.
2. **unmapped_voter from post-snapshot swearing-ins.** Any member sworn in after the snapshot's (unknown) source date. Impact: the whole roll fails. Likelihood: medium, and it depends on how far the source commit is behind 2026-10-21. Check the actual source date of d5af3d2 before the census.
3. **Date-boundary artifacts.** Rolls on 2023-01-03 or 2025-01-03 where departing and arriving members both appear. Inclusive overlap accepts both, so no failure is expected. Low.
4. **Senate VP tie-breaks.** A VP entry that reaches identity would be unmapped. Skipped at collector level, so low for identity, but untested in fixtures. Low.
5. **Senate LIS gaps and duplicates.** None in the snapshot. Low.
6. **Hash mismatch or snapshot drift.** Pinned hash matches. Very low.

## Commands run (abbreviated outputs)

```
git rev-parse HEAD -> e3eb78956c36f1a4a275a8907d2f01f10f2ce6ba
sha256sum fixtures/votes/identity/legislators-d5af3d2-voting-terms.json -> 582e5b3e825b54b323c7720cac0f39d6d92e42baf1c009ccb78702a863ac9fe8
python3 -I -B -c '<load snapshot; print keys/people/terms; max start>'
  -> terms 2491; max start 2026-09-02; max end 2031-01-03; people 895
python3 -I -B -c '<terms starting after 2026-06-01>'
  -> B001328 (2026-09-01), G000607 (2026-06-10), G000608 S441 (2026-07-14), W000832 (2026-09-02)
python3 -I -B -c '<day-by-day inclusive coverage of 4 targets over window>'
  -> 0 uncovered days for H001047, A000370, S000033, W000817
python3 -I -B -c '<senate lis null / duplicates / VP>'
  -> senate in-window 126; lis null 0; dup LIS []; odd bioguide []
python3 -I -B -c '<mid-window departure list>'
  -> jan3 expirations 147; mid-window ends 40
grep -rn "'VP'" lib/collector-bridge.ts skills/researcher/official-member-votes.ts -> skip lines 70, 144
grep -rln "d5af3d2" (repo, excl node_modules) -> SOURCES.md, manifest, two docs, README, derive_identity.ts, lib/official-identity.ts
git cat-file -t d5af3d2... -> fatal: could not get object info (upstream not local)
python3 -I -B -c '<parse 7 XML fixtures; map IDs with serves()>'
  -> all voters ok except 1 out-of-service "Not Voting" (G000578, house-2025-roll001.xml)
```

Temporary helper script written during the audit was deleted; this report is the only file written.
