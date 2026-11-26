# Pinned voting identity

Current pin: `legislators-2b1fe72-voting-terms.json`, derived without network
from congress-legislators commit `2b1fe728159fe5f5e145277794106e800719eb50`
(CC0-1.0). Inputs and complete upstream URLs, byte lengths and SHA256 hashes
are embedded in the JSON; fetch receipts are listed in `SOURCES.md` (identity
snapshot refresh, 2026-11-24).

Command from repository root:

```sh
node_modules/.bin/tsx tools/congress-collector/derive_identity.ts --current artifacts/2026-11-24-roster-freshness/identity-probe/legislators-current.yaml --historical artifacts/2026-11-24-roster-freshness/identity-probe/legislators-historical.yaml --out fixtures/votes/identity/legislators-2b1fe72-voting-terms.json
```

Output SHA256: `c5c8509eb23ad9e414644810cfef5f160508b87a1cd4a3472ebea2af1fa2fe46`.
Two derivations were byte-identical: 895 people, 2,492 retained dated terms.
Contract version 2. Floor: 2019-01-03. `as_of`: 2026-11-24. Lookups before the
floor or after `as_of` fail closed. People and terms before the stated retention
rule are excluded. This is dated identity provenance, not evidence of complete
roll acquisition.

Against the previous pin, only two people differ: H001104 (Jon Husted, end
2026-11-03 → 2026-12-15) and M001244 (Ashley Moody, new term 2026-11-04 →
2029-01-03).

## Superseded pin

`legislators-d5af3d2-voting-terms.json` (commit
`d5af3d2d2490f8c6532c9490b1f47a76cacca699`, contract version 1, SHA256
`582e5b3e825b54b323c7720cac0f39d6d92e42baf1c009ccb78702a863ac9fe8`, 895 people,
2,491 terms) is kept unchanged because archived validation records cite it. The
current loader rejects it. It was derived from
`artifacts/govtrack-replacement-2026-10-16-0907/source-packet/`, using the
version of `derive_identity.ts` in git history before this refresh.
