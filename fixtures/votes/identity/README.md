# Pinned voting identity

Derived without network from congress-legislators commit
`d5af3d2d2490f8c6532c9490b1f47a76cacca699` (CC0-1.0). Inputs and complete
upstream URLs, byte lengths and SHA256 hashes are embedded in the JSON.
The historical input is the complete 8,997,407-byte file recorded by
`historical-complete-receipt.json`, never the retained `.partial` response.

Command from repository root:

```sh
node_modules/.bin/tsx tools/congress-collector/derive_identity.ts --current artifacts/govtrack-replacement-2026-10-16-0907/source-packet/legislators-current.yaml --historical artifacts/govtrack-replacement-2026-10-16-0907/source-packet/legislators-historical.yaml --out fixtures/votes/identity/legislators-d5af3d2-voting-terms.json
```

Output SHA256: `582e5b3e825b54b323c7720cac0f39d6d92e42baf1c009ccb78702a863ac9fe8`.
Two derivations were byte-identical: 895 people, 2,491 retained dated terms.
Floor: 2019-01-03. People and terms before the stated retention rule are excluded.
This is dated identity provenance, not evidence of complete roll acquisition.
