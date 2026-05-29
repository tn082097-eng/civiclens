#!/usr/bin/env bash
# run-batch-full.sh — full member batch WITH vote→bill linkage repair.
#
# Chains the three stages in the correct order so the vault/site never show a
# diluted linkage %:
#   1. pipeline batch   — run the members (auto-syncs each to DuckDB)
#   2. --load-bills      — link the new members' votes to bills (repairs the %)
#   3. vault regen       — rebuild Obsidian notes AFTER linkage is correct
#
# The batch (step 1) also regenerates the vault internally; step 3 re-runs it so
# the notes reflect the post-linkage numbers. One extra regen, intentional.
#
# Long-running — start it in a SEPARATE terminal so it survives session close:
#   nohup ./run-batch-full.sh "Michael McCaul,Dan Goldman,Blake Moore" \
#     > ~/civiclens-run.log 2>&1 &
#   tail -f ~/civiclens-run.log

set -euo pipefail
cd "$(dirname "$0")"

NAMES="${1:?usage: run-batch-full.sh \"Name1,Name2,...\"}"

echo "── [1/3] pipeline batch ───────────────────────────────"
npx tsx agents/pipeline.ts --batch "$NAMES"

echo "── [2/3] link new votes to bills (--load-bills) ───────"
npx tsx agents/pipeline.ts --load-bills --api-pass

echo "── [3/3] regenerate vault with corrected linkage ──────"
npx tsx render/connections-to-vault.ts

echo "── done ───────────────────────────────────────────────"
