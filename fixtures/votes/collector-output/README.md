# Pinned collector output — official retained fixtures

Generated 2026-10-16 by the real unitedstates/congress parser at commit
8184bcb13160da2389dea4c902de67817db681fc. All seven results are `ok`.
This is fixture parsing evidence, not full-window coverage or certification.
The JSON is the bridge stdout, unedited; its format has no input path fields.
Input paths are recorded repo-relative below. Absolute execution inputs are
retained in the ignored worker run directory.

Reproduction command (from repo root, with the runtime installed):

```
python3 -I -B artifacts/govtrack-replacement-2026-10-16-0907/workers/collector-runtime-codex/freeze-official.py
```

The script executes `unshare -rn <repo>/tools/congress-collector/.runtime/venv/bin/python -I -B <repo>/tools/congress-collector/bridge.py`
with a fresh temp cwd, HOME and TMPDIR and a minimal environment. It refuses to
overwrite the frozen output. Requests contain the SHA256 below; source receipts
are in `fixtures/votes/manifest.json`. No requests were made to official hosts.

| Input path | SHA256 |
| --- | --- |
| fixtures/votes/house-acquisition/house-2025-roll001.xml | 876aa39e6cfe58942eb5a3b24628975b288e6c5fca8d8e0257dfcd7d180163fd |
| fixtures/votes/official-samples/house-speaker-2025-roll002.xml | a452d484b1a1219dd61061fe870ab9c3fa087de512b24033ff6db86a2b38c0c4 |
| fixtures/votes/official-samples/house-bill-2025-roll006.xml | 58c75e9750226a49c55712812dc40dda0e67a192e5e18f4a49cbf32e3346ed6e |
| fixtures/votes/official-samples/senate-119-1-roll00001.xml | 9d71d78a54c83522babd743209ca4a1a27baa2df122d6830c50ec2aa512ea17e |
| fixtures/votes/official-samples/senate-amendment-119-1-roll00003.xml | f099e753743dc41ebd73aeb6164bb69cb1a52033859c1123fc8ea9ffe77fe94d |
| fixtures/votes/official-samples/senate-bill-119-1-roll00570.xml | abf2ebf8da845213e464d9eec4d258b90394efd90d5c66d915f41cc48da7ae7a |
| fixtures/votes/official-samples/senate-nomination-119-1-roll00655.xml | edf44e13beb93b2010b809f36cdab594ad159c81a0ad992cdaf8806a07ac66c5 |

Output SHA256: `3390cdabeabe1eca7919b980f5481d49330a97e901a9586b908db92e8c5abb01`.

Installed runtime metadata:

```json
{
  "python": "3.12.3",
  "packages": {
    "charset-normalizer": "3.5.2",
    "scrapelib": "2.4.1",
    "certifi": "2026.7.22",
    "requests": "2.34.2",
    "lxml": "6.1.3",
    "pytz": "2026.5",
    "idna": "3.20",
    "urllib3": "2.8.0"
  },
  "lock_sha256": "e5de05c0f32d5d928b57a36432f7e24132bba1a48771396e952151d1d41b11e8",
  "vendor_manifest_sha256": "c9b17dc4b6b5cd0285a8649f0110d9ffc0b733bfc764fb778987650abec58e57",
  "created_at": "2026-10-16T13:46:30.139882+00:00"
}
```
