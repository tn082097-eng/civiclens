#!/usr/bin/env bash
# Assemble the launch artifact (public/) from the locally verified site/
# build. Deploy flow per docs/adr/0002 §C: local verified build -> committed
# public/ -> GitHub Pages. CI never rebuilds. Roster membership is governed by
# the ADR 0002 §B.1 inclusion rule; MEMBERS below is the opt-in list.
#
# Contents:
#   public/index.html                    landing, rendered from the
#                                        published-members manifest (below)
#   public/404.html                      beta notice (in git, not copied)
#   public/methodology.html              copied from verified site/
#   public/members/<slug>.html           copied from verified site/
#
# Landing flow: scripts/update-manifest.ts refreshes each packaged member's
# inventory stats in render/published-members.json from the DB, then
# render/build.ts --landing renders site/landing.html from that manifest
# (never from the DB). The freshness guard below rejects packaging when the
# DB is newer than a member's verified render — stats and page content must
# come from the same snapshot.
#
# Known internal links that intentionally resolve to the 404 beta notice:
# peer-member pages (Shared-donor peers + Co-sponsorship tables) and
# network.html (cosponsor lede). "<- back to corpus" resolves to the landing.
#
# Fails loudly if a verified source page is missing or stale. Re-run after
# any re-verified rebuild; then commit the diff (or the lack of one).
set -euo pipefail
cd "$(dirname "$0")/.."

# Roster per ADR 0002 §B.1: theme-gaps band `ranked` or `low-power`, and a
# sitting member of the current Congress. Publication is opt-in — a member not
# listed here cannot reach the site.
MEMBERS=(
  blake-moore dan-crenshaw lois-frankel nancy-pelosi
  ron-wyden sheldon-whitehouse susan-collins
)
DB=data/civiclens.duckdb

for f in site/methodology.html "$DB"; do
  [[ -f "$f" ]] || { echo "missing: $f (run render/build.ts first)" >&2; exit 1; }
done
for m in "${MEMBERS[@]}"; do
  src="site/members/${m}.html"
  [[ -f "$src" ]] || { echo "missing verified source: $src" >&2; exit 1; }
  if [[ "$DB" -nt "$src" ]]; then
    echo "DB is newer than verified render for ${m} — re-run: npx tsx render/build.ts --member ${m}" >&2
    exit 1
  fi
done

# Fail closed if a removed slug is still reachable in the public artifact.
for page in public/members/*.html; do
  [[ -e "$page" ]] || continue
  slug=${page##*/}
  slug=${slug%.html}
  listed=false
  for member in "${MEMBERS[@]}"; do
    if [[ "$member" == "$slug" ]]; then listed=true; break; fi
  done
  "$listed" || { echo "public page outside the approved roster: $page" >&2; exit 1; }
done

npx --no-install tsx scripts/validate-release-roster.ts "${MEMBERS[@]}"

npx tsx scripts/update-manifest.ts "${MEMBERS[@]}"
npx tsx render/build.ts --landing

mkdir -p public/members
cp site/landing.html public/index.html
cp site/methodology.html public/methodology.html
for m in "${MEMBERS[@]}"; do
  cp "site/members/${m}.html" "public/members/${m}.html"
done

echo "packaged: $(find public -type f | sort)"
