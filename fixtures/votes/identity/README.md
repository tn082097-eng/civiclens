# Pinned voting identity

Current pin: `legislators-2b1fe72-asof-2026-11-26-voting-terms.json`, derived
without network from congress-legislators commit
`2b1fe728159fe5f5e145277794106e800719eb50` (CC0-1.0). Inputs and complete
upstream URLs, byte lengths and SHA256 hashes are embedded in the JSON. Fetch
receipts and the official-roster cross-check are listed in `SOURCES.md`
(identity snapshot, re-captured 2026-11-26).

Command from repository root:

```sh
node_modules/.bin/tsx tools/congress-collector/derive_identity.ts --current artifacts/2026-11-26-identity-pin/sources/legislators-current.yaml --historical artifacts/2026-11-26-identity-pin/sources/legislators-historical.yaml --as-of 2026-11-26 --out fixtures/votes/identity/legislators-2b1fe72-asof-2026-11-26-voting-terms.json
```

Output SHA256: `55764e7ce55dc58ea41f56895bb04fbf843fdfb3fb1fdc79ed5c38a41c8ec6a1`.
Two derivations were byte-identical: 895 people, 2,492 retained dated terms.
Contract version 2. Floor: 2019-01-03. `as_of`: 2026-11-26. Lookups before the
floor or after `as_of` fail closed. People and terms before the stated retention
rule are excluded. This is dated identity provenance, not evidence of complete
roll acquisition.

## Refreshing the pin

`as_of` is the last date the snapshot is trusted for. To move it:

1. Re-capture both YAML files at the chosen commit, with receipts, and record
   them in `SOURCES.md`.
2. Run `tools/congress-collector/crosscheck_identity_roster.ts` for the new date
   against freshly fetched `https://clerk.house.gov/xml/lists/MemberData.xml`
   and `https://www.senate.gov/general/contact_information/senators_cfm.xml`.
   It must pass.
3. Derive twice with `--as-of <date>` and confirm the outputs are byte-identical.
   Diff the result against the current pin, and explain every changed person
   from an official source.
4. Update `IDENTITY_SNAPSHOT_PATH`, `IDENTITY_SNAPSHOT_SHA256` and
   `IDENTITY_AS_OF` in `lib/official-identity.ts`. Keep the old file: archived
   records cite it.

## Superseded: `legislators-2b1fe72-voting-terms.json` (`as_of` 2026-11-24)

Same commit and inputs, SHA256 `c5c8509e…fe46`. It differs from the current file
only in `as_of`, and the current loader rejects it. `derive_identity.ts
--as-of 2026-11-24` on the 2026-11-24 inputs reproduces it exactly. Against the
`d5af3d2` pin, only two people differ: H001104 (Jon Husted, end
2026-11-03 → 2026-12-15) and M001244 (Ashley Moody, new term 2026-11-04 →
2029-01-03).

## Superseded: `legislators-d5af3d2-voting-terms.json`

`legislators-d5af3d2-voting-terms.json` (commit
`d5af3d2d2490f8c6532c9490b1f47a76cacca699`, contract version 1, SHA256
`582e5b3e825b54b323c7720cac0f39d6d92e42baf1c009ccb78702a863ac9fe8`, 895 people,
2,491 terms) is kept unchanged because archived validation records cite it. The
current loader rejects it. It was derived from
`artifacts/govtrack-replacement-2026-10-16-0907/source-packet/`, using the
version of `derive_identity.ts` in git history before this refresh.
