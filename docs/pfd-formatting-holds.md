# PFD formatting holds

This is the durable queue for members whose authoritative financial-disclosure
source exists but cannot yet be represented completely and safely by the
supported parser.

## Rule

- Record `needs_manual_formatting` with the member, bioguide, chamber, filing or
  source range, and a source-backed reason.
- Withhold the affected filing and stop that member's automated onboarding and
  publication path. Continue processing other members.
- Keep the member in coverage. A hold is not `verified-empty`, a successful
  ingestion, a certification pass, or permission to remove or replace a frozen
  trial member.
- Do not add a member-specific parser or silently run OCR. Clear a hold only
  after a general parser, OCR, or human-review path is separately approved,
  verified, and replayed for the member.

## Open holds

| Member | Bioguide | Chamber | Filing / source | State | Source-backed reason | Added |
|---|---|---|---|---|---|---|
| Eric Burlison | B001316 | House | [Clerk PTR DocID 8219414](https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2023/8219414.pdf) | `needs_manual_formatting` | Official PDF has no usable native text; OCR was outside the frozen trial boundary | 2026-09-13 |

## Cleared holds

Move a row here only after recording the general resolution, verification
evidence, replay result, and date. Do not delete historical hold records.

| Member | Filing / source | Resolution evidence | Cleared |
|---|---|---|---|
