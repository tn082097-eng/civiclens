#!/usr/bin/env python3
"""Typeset the CivicLens Atlas spoken-text export into a print-ready HTML doc.

Structure is derived from the source text, not retyped, so the PDF stays
faithful to the artifact. One editorial addition: an annotation on the two
'two members published' claims, which repo evidence contradicts (1 published).
"""
import html
import re

SRC = "/home/captainanime/.claude/jobs/22939220/tmp/atlas/source.txt"
OUT = "/home/captainanime/.claude/jobs/22939220/tmp/atlas/civiclens-atlas.html"

lines = open(SRC, encoding="utf-8").read().split("\n")

# ---------------------------------------------------------------- parse
# Strip the header block (title, subtitle, preamble) and the rule lines.
RULE = re.compile(r"^={10,}$")
PART = re.compile(r"^PART (\d)\. (.+)$")
GROUP = re.compile(r"^-- (.+?) \((\d+) items?\) --$")
NUMBERED = re.compile(r"^(\d+)\. (.+)$")
INDENT_NUM = re.compile(r"^  (\d+)\. (.+)$")
FIELD = re.compile(r"^   ([A-Z][A-Za-z ]*?): (.+)$")
IDENT = re.compile(r"^   Identifier: (.+)$")

body = []          # list of block dicts
i = 0
n = len(lines)

# header: everything before the first ====== rule
while i < n and not RULE.match(lines[i]):
    i += 1

cur_part = None
cur_group = None
cur_item = None

def flush_item():
    global cur_item
    if cur_item:
        body.append(cur_item)
        cur_item = None

while i < n:
    ln = lines[i]
    raw = ln.rstrip()

    if RULE.match(raw):
        i += 1
        continue

    m = PART.match(raw)
    if m:
        flush_item()
        cur_part = (m.group(1), m.group(2))
        body.append({"t": "part", "num": m.group(1), "title": m.group(2)})
        cur_group = None
        i += 1
        continue

    m = GROUP.match(raw)
    if m:
        flush_item()
        cur_group = m.group(1)
        body.append({"t": "group", "title": m.group(1), "count": m.group(2)})
        i += 1
        continue

    # inside PART 3: numbered component entries
    if cur_group and NUMBERED.match(raw):
        flush_item()
        m = NUMBERED.match(raw)
        cur_item = {"t": "item", "num": m.group(1), "title": m.group(2),
                    "ident": None, "lead": [], "fields": []}
        i += 1
        continue

    if cur_item is not None:
        m = IDENT.match(raw)
        if m:
            cur_item["ident"] = m.group(1)
            i += 1
            continue
        m = FIELD.match(raw)
        if m:
            cur_item["fields"].append((m.group(1), m.group(2)))
            i += 1
            continue
        if raw.strip() == "":
            i += 1
            continue
        if raw.startswith("   "):
            cur_item["lead"].append(raw.strip())
            i += 1
            continue
        # dedent -> item ended
        flush_item()
        continue

    # PART 1 / PART 2 / PART 4 prose
    if raw.strip() == "":
        i += 1
        continue

    m = NUMBERED.match(raw)
    if m:
        body.append({"t": "story", "num": m.group(1), "title": m.group(2)})
        i += 1
        continue

    if raw.startswith("  "):
        body.append({"t": "sub", "text": raw.strip()})
    else:
        body.append({"t": "p", "text": raw.strip()})
    i += 1

flush_item()

# ---------------------------------------------------------------- render
def esc(s):
    return html.escape(s, quote=False)

def smart(s):
    """Light typographic cleanup; keep code-ish tokens intact."""
    s = esc(s)
    s = re.sub(r"\bp equals ([0-9.]+)", r"p = \1", s)
    s = re.sub(r"\btimes (\d)", r"× \1", s)
    s = s.replace(" -- ", " — ")
    return s

def codify(s):
    """Wrap filename/flag-looking tokens in <code>."""
    s = smart(s)
    s = re.sub(r"(?<![\w/.-])((?:[\w./-]+/)?[\w.-]+\.(?:ts|sh|md|json|yml|duckdb|html))(?![\w])",
               r"<code>\1</code>", s)
    s = re.sub(r"(?<![\w-])(--[a-z][a-z-]+)", r"<code>\1</code>", s)
    return s

STALE = "two members published"
STALE2 = "2 members published"

parts = []
parts.append(f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>CivicLens Atlas</title>
<style>
@page {{ size: Letter; margin: 17mm 15mm 15mm 15mm; }}
* {{ box-sizing: border-box; }}
body {{
  font-family: "Source Serif Pro", Georgia, "Times New Roman", serif;
  font-size: 10.1pt; line-height: 1.5; color: #14161c; margin: 0;
}}
code {{
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 8.6pt; background: #eef0f6; padding: 0.3mm 1mm;
  border-radius: 0.8mm; color: #2a2f45;
}}
.cover {{ padding-top: 46mm; page-break-after: always; }}
.cover h1 {{
  font-size: 33pt; letter-spacing: -0.022em; margin: 0 0 3mm;
  line-height: 1.02; font-weight: 600;
}}
.cover .tag {{ font-size: 13.5pt; color: #3f4660; margin: 0 0 12mm; font-style: italic; }}
.cover .meta {{
  font-family: ui-sans-serif, system-ui, sans-serif; font-size: 8.6pt;
  letter-spacing: 0.1em; text-transform: uppercase; color: #6a7189;
  border-top: 2px solid #14161c; padding-top: 3mm; margin-top: 4mm;
}}
.cover .note {{
  margin-top: 13mm; font-size: 9.4pt; color: #3f4660; max-width: 108mm;
  line-height: 1.55;
}}
.toc {{ margin-top: 9mm; font-size: 9.6pt; }}
.toc div {{ padding: 1.1mm 0; border-bottom: 0.4px solid #d8dbe6; }}
.toc b {{ font-family: ui-sans-serif, system-ui, sans-serif; font-size: 8.2pt;
  letter-spacing: 0.09em; color: #6a7189; margin-right: 3mm; }}
h2.part {{
  font-size: 8.8pt; font-family: ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.16em; text-transform: uppercase; color: #4d5470;
  margin: 0 0 5mm; padding-bottom: 2mm; border-bottom: 2px solid #14161c;
  page-break-after: avoid;
}}
h3.group {{
  font-size: 11.6pt; margin: 8mm 0 3mm; letter-spacing: -0.005em;
  page-break-after: avoid;
}}
.gcount {{
  font-family: ui-sans-serif, system-ui, sans-serif; font-size: 7.6pt;
  letter-spacing: 0.08em; text-transform: uppercase; color: #6a7189;
  border: 0.6px solid #b9bfd2; border-radius: 6mm; padding: 0.5mm 2mm;
  vertical-align: 0.9mm; margin-left: 2.5mm; font-weight: 600;
}}
.story {{ margin: 0 0 4mm; page-break-inside: avoid; }}
.story .n {{
  font-family: ui-sans-serif, system-ui, sans-serif; font-size: 8pt;
  font-weight: 700; color: #8a91a8; letter-spacing: 0.06em;
}}
.story h4 {{ font-size: 11.4pt; margin: 0.6mm 0 1.4mm; letter-spacing: -0.008em; }}
.story p {{ margin: 0; color: #2b3145; }}
.item {{
  page-break-inside: avoid; margin: 0 0 4.5mm; padding: 2.6mm 0 0 0;
  border-top: 0.5px solid #d8dbe6;
}}
.item:first-of-type {{ border-top: none; }}
.item .hd {{ margin-bottom: 1.4mm; }}
.item h4 {{ font-size: 10.7pt; margin: 0; display: inline; letter-spacing: -0.005em; }}
.item .id {{
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 8pt;
  color: #6a7189; margin-left: 2.5mm;
}}
.item .lead {{ margin: 0 0 1.8mm; color: #2b3145; }}
table.f {{ width: 100%; border-collapse: collapse; font-size: 8.9pt; }}
table.f td {{ padding: 0.9mm 0; vertical-align: top; border: none; }}
table.f td.k {{
  width: 27mm; font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 7.6pt; letter-spacing: 0.05em; text-transform: uppercase;
  color: #6a7189; padding-right: 3mm; padding-top: 1.35mm; font-weight: 600;
}}
table.f td.v {{ color: #2b3145; }}
p.body {{ margin: 0 0 2.6mm; }}
p.sub {{
  margin: 0 0 2.2mm 5mm; color: #3f4660; font-size: 9.5pt;
  border-left: 1.5px solid #c3c9da; padding-left: 3.5mm;
}}
.flag {{
  display: block; margin: 1.6mm 0 0; padding: 1.8mm 2.6mm;
  border-left: 2.2px solid #9a3324; background: #fbf3f1;
  font-size: 8.5pt; color: #6d2a1e; line-height: 1.42;
}}
.flag b {{ font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 7.4pt; letter-spacing: 0.08em; text-transform: uppercase; }}
.edges {{ column-count: 2; column-gap: 9mm; font-size: 9pt; margin-top: 1mm; }}
.edges div {{
  break-inside: avoid; padding: 0.75mm 0; color: #2b3145;
  border-bottom: 0.4px solid #e2e5ee;
}}
.edges .a {{ font-weight: 600; }}
.edges .to {{ color: #8a91a8; font-size: 8pt; }}
.end {{
  margin-top: 8mm; padding-top: 2.5mm; border-top: 2px solid #14161c;
  font-size: 8.2pt; color: #6a7189;
  font-family: ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.05em;
}}
.newpage {{ page-break-before: always; }}
</style></head><body>""")

# ---- cover
parts.append("""
<div class="cover">
<h1>CivicLens Atlas</h1>
<p class="tag">How public data becomes evidence.</p>
<div class="meta">System atlas &nbsp;·&nbsp; project status 26 July 2026</div>
<p class="note">A written edition of the CivicLens system atlas. Everything the
interactive map holds is set out below in reading order, including the detail
panels normally hidden behind a click.</p>
<div class="toc">
<div><b>Part 1</b> The story</div>
<div><b>Part 2</b> Project status</div>
<div><b>Part 3</b> The system, piece by piece</div>
<div><b>Part 4</b> How the pieces connect</div>
</div>
<p class="note" style="margin-top:10mm;font-size:8.6pt;color:#6a7189;">
Typeset from the atlas text export. Content is reproduced as written; one
factual annotation is marked inline where repository evidence disagrees.</p>
</div>""")

edges = []
in_part4 = False
first_part = True
open_story = [False]

def close_story():
    if open_story[0]:
        parts.append("</div>")
        open_story[0] = False

for b in body:
    t = b["t"]

    if t == "part":
        close_story()
        if b["num"] == "4":
            in_part4 = True
        pre = "" if first_part else '<div class="newpage"></div>'
        parts.append(f'{pre}<h2 class="part">Part {b["num"]} — {esc(b["title"].title())}</h2>')
        first_part = False
        continue

    if t == "group":
        close_story()
        parts.append(
            f'<h3 class="group">{esc(b["title"].title())}'
            f'<span class="gcount">{b["count"]}</span></h3>')
        continue

    if t == "story":
        # Open a keep-together block; the following prose closes it.
        parts.append(
            f'<div class="story"><div class="n">{b["num"]}</div>'
            f'<h4>{smart(b["title"])}</h4>')
        open_story[0] = True
        continue

    if t == "item":
        h = [f'<div class="item"><div class="hd"><h4>{smart(b["title"])}</h4>']
        if b["ident"]:
            h.append(f'<span class="id">{esc(b["ident"])}</span>')
        h.append("</div>")
        for L in b["lead"]:
            h.append(f'<p class="lead">{codify(L)}</p>')
        if b["fields"]:
            h.append('<table class="f">')
            for k, v in b["fields"]:
                row = f'<tr><td class="k">{esc(k)}</td><td class="v">{codify(v)}</td></tr>'
                h.append(row)
                if STALE2 in v:
                    h.append(
                        '<tr><td class="k"></td><td class="v"><span class="flag">'
                        '<b>Annotation — repository evidence</b><br>'
                        'The committed launch artifact contains one member page '
                        '(<code>josh-gottheimer.html</code>); '
                        '<code>published-members.json</code> lists one member. '
                        'Pelosi appears only in fixtures and planning documents. '
                        'Verified 26 Jul 2026.</span></td></tr>')
            h.append("</table>")
        h.append("</div>")
        parts.append("".join(h))
        continue

    if t == "sub":
        txt = b["text"]
        if in_part4 and " connects to " in txt:
            a, z = txt.rstrip(".").split(" connects to ")
            edges.append((a, z))
            continue
        parts.append(f'<p class="sub">{codify(txt)}</p>')
        continue

    if t == "p":
        txt = b["text"]
        if in_part4 and " connects to " in txt:
            a, z = txt.rstrip(".").split(" connects to ")
            edges.append((a, z))
            continue
        block = f'<p class="body">{codify(txt)}</p>'
        if STALE in txt:
            block += ('<p class="flag"><b>Annotation — repository evidence</b><br>'
                      'Repository check on 26 July 2026 finds <b>one</b> member '
                      'published, not two: <code>public/members/</code> contains only '
                      '<code>josh-gottheimer.html</code>. Pelosi appears solely in test '
                      'fixtures and planning documents. 57 members are ingested in the '
                      'database; ingestion scope and publication scope differ.</p>')
        parts.append(block)
        continue

if edges:
    parts.append('<div class="edges">')
    for a, z in edges:
        parts.append(f'<div><span class="a">{esc(a)}</span> '
                     f'<span class="to">→</span> {esc(z)}</div>')
    parts.append("</div>")

parts.append('<p class="end">End of the CivicLens atlas.</p>')
parts.append("</body></html>")

open(OUT, "w", encoding="utf-8").write("\n".join(parts))
print("wrote", OUT)
print("edges:", len(edges))
