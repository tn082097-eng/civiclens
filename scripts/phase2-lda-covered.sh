#!/usr/bin/env bash
# LDA revolving-door slice (direct lane): per-member covered_position harvest.
# Server-side lobbyist_covered_position search collapses the page count from
# ~4k/year (full corpus) to a few pages per member-year. Surname = last token
# of the member name (substring search, so "Schultz" covers "Wasserman Schultz").
# 4.2s delay ≈ 14 req/min, under the anonymous 15/min limit.
set -u
cd "$(dirname "$0")/.."
i=0
total=$(awk 'NF {print $NF}' names.txt | sort -u | wc -l)
awk 'NF {print $NF}' names.txt | sort -u | while read -r surname; do
  i=$((i+1))
  echo "════ [$i/$total] covered ~ \"$surname\""
  npx tsx db/load-lda.ts --years 2018-2026 --resume --covered "$surname" --delay-ms 4200 \
    || echo "✗ FAILED surname: $surname"
done
echo "LDA covered-position harvest done"
