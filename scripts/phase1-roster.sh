#!/usr/bin/env bash
# Phase 1 — roster balance: fetch-only research for 10 House Democrats.
# Deterministic fetch + DuckDB sync, NO LLM agents (--refresh-research).
# Sequential on purpose: DuckDB is single-writer per file; parallel
# --refresh-research processes would contend for the lock.
#
# Run from a separate terminal (NOT inside Claude Code):
#   cd ~/Developer/civiclens && nohup bash scripts/phase1-roster.sh &
#   tail -f logs/phase1-roster.log
# The script redirects its own output to logs/phase1-roster.log — no shell
# redirection needed (a wrapped paste of `> logs/...` broke the first attempt).
set -u
cd "$(dirname "$0")/.."
mkdir -p logs
exec > logs/phase1-roster.log 2>&1

MEMBERS=(
  "Jim Himes"
  "Don Beyer"
  "Scott Peters"
  "Bill Foster"
  "Debbie Wasserman Schultz"
  "Steven Horsford"
  "Susie Lee"
  "Maxine Waters"
  "Frank Pallone"
  "Dan Goldman"
)

pass=0; fail=0
for name in "${MEMBERS[@]}"; do
  echo "════════════════════════════════════════════════════════"
  echo "▶ $(date '+%H:%M:%S')  $name"
  if npx tsx agents/pipeline.ts --refresh-research "$name"; then
    pass=$((pass+1))
  else
    fail=$((fail+1))
    echo "✗ FAILED: $name"
  fi
done

echo "════════════════════════════════════════════════════════"
echo "Phase 1 batch done: $pass ok, $fail failed"
exit $(( fail > 0 ? 1 : 0 ))
