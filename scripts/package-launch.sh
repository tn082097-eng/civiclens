#!/usr/bin/env bash
# Assemble the single-member launch artifact (public/) from the locally
# verified site/ build. Deploy flow per docs/adr/0002 §C: local verified
# build -> committed public/ -> GitHub Pages. CI never rebuilds.
#
# Contents:
#   public/index.html                    hand-written landing (in git, not copied)
#   public/404.html                      beta notice (in git, not copied)
#   public/methodology.html              copied from verified site/
#   public/members/josh-gottheimer.html  copied from verified site/
#
# Known internal links that intentionally resolve to the 404 beta notice:
# peer-member pages (Shared-donor peers + Co-sponsorship tables) and
# network.html (cosponsor lede). "<- back to corpus" resolves to the landing.
#
# Fails loudly if a verified source page is missing. Re-run after any
# re-verified rebuild; then commit the diff (or the lack of one).
set -euo pipefail
cd "$(dirname "$0")/.."

MEMBERS=(josh-gottheimer)

for f in site/methodology.html; do
  [[ -f "$f" ]] || { echo "missing verified source: $f (run render/build.ts first)" >&2; exit 1; }
done

mkdir -p public/members
cp site/methodology.html public/methodology.html
for m in "${MEMBERS[@]}"; do
  src="site/members/${m}.html"
  [[ -f "$src" ]] || { echo "missing verified source: $src" >&2; exit 1; }
  cp "$src" "public/members/${m}.html"
done

echo "packaged: $(find public -type f | sort)"
