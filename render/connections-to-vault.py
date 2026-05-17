#!/usr/bin/env python3
"""Regenerate Obsidian connection notes from the latest connection-mapper output per member.

Source : ~/.hermes/civiclens/pipeline/task-*/connection-mapper.json (latest per member by dir mtime)
Output : ~/NoService/Projects/CivicLens/Connections/<member-id>.md
Also   : ~/NoService/Projects/CivicLens/Members/<Display Name>.md (graph stub per member)

Sanders dedup: bernard-sanders is folded into bernie-sanders (same bioguide S000033).
Run: python3 render/connections-to-vault.py
"""
import json, os, glob, datetime

REPO = os.path.expanduser("~/.hermes/civiclens")
PIPELINE = os.path.join(REPO, "pipeline")
VAULT = os.path.expanduser("~/NoService/Projects/CivicLens")
CONN_DIR = os.path.join(VAULT, "Connections")
MEM_DIR = os.path.join(VAULT, "Members")

# Canonicalize the Sanders duplicate everywhere.
ALIAS_ID = {"bernard-sanders": "bernie-sanders"}
ALIAS_NAME = {"Bernard Sanders": "Bernie Sanders"}


def canon_id(i):
    return ALIAS_ID.get(i, i)


def canon_name(n):
    return ALIAS_NAME.get(n, n)


def latest_per_member():
    """Return {member_id: (json_path, mtime)} keeping the newest run per member."""
    best = {}
    tasks = sorted(
        glob.glob(os.path.join(PIPELINE, "task-*/")),
        key=os.path.getmtime,
        reverse=True,
    )
    for d in tasks:
        cm = os.path.join(d, "connection-mapper.json")
        if not os.path.isfile(cm):
            continue
        try:
            data = json.load(open(cm))
        except Exception:
            continue
        sid = canon_id(data.get("subjectId", ""))
        if not sid or sid in best:
            continue  # dirs walked newest-first, first hit wins
        best[sid] = (cm, data)
    return best


def fmt_links(items, kind):
    """Render directLinks / hiddenConnections / indirectLinks as wikilinked bullets."""
    out = []
    for x in items:
        name = canon_name(x.get("toName") or x.get("to", "?"))
        strength = x.get("strength")
        s = f" ({strength:.2f})" if isinstance(strength, (int, float)) else ""
        if kind == "hidden":
            via = x.get("via", "")
            ev = x.get("evidence", "")
            out.append(f"- [[{name}]]{s} — via **{via}**. {ev}")
        elif kind == "indirect":
            via = x.get("via", "")
            lt = x.get("linkType", "")
            out.append(f"- [[{name}]]{s} — *{lt}* via {via}")
        else:
            ev = x.get("evidence", "")
            out.append(f"- [[{name}]]{s} — {ev}")
    return out or ["- _(none)_"]


def render(member_id, data):
    name = canon_name(data.get("subjectName", member_id))
    analyzed = data.get("analyzedAt", "")
    compared = data.get("comparedAgainst", [])
    # Dedup compared list after aliasing.
    seen, comp_names = set(), []
    for c in compared:
        cid = canon_id(c.get("id", ""))
        if cid and cid != member_id and cid not in seen:
            seen.add(cid)
            comp_names.append(canon_name(c.get("name", cid)))

    lines = []
    lines.append("---")
    lines.append(f"member: {name}")
    lines.append(f"member_id: {member_id}")
    lines.append(f"analyzed_at: {analyzed}")
    lines.append(f"corpus_size: {len(comp_names)}")
    lines.append("tags: [civiclens, connection-map]")
    lines.append("---")
    lines.append("")
    lines.append(f"# {name} — Connection Map")
    lines.append("")
    lines.append(f"Latest connection-mapper run for [[{name}]]. Subject ID: `{member_id}`.")
    lines.append("")
    lines.append(f"- Analyzed: {analyzed}")
    lines.append(f"- Corpus: {len(comp_names)} members compared")
    lines.append("- Hub: [[CivicLens]]")
    lines.append("")

    summary = data.get("networkSummary")
    if summary:
        lines += ["## Network summary", "", summary, ""]

    lines += ["## Direct links", ""] + fmt_links(data.get("directLinks", []), "direct") + [""]
    lines += ["## Hidden connections", ""] + fmt_links(data.get("hiddenConnections", []), "hidden") + [""]
    lines += ["## Indirect links", ""] + fmt_links(data.get("indirectLinks", []), "indirect") + [""]

    sd = data.get("sharedDonors", [])
    lines += ["## Shared donors", ""]
    if sd:
        for d in sd:
            who = ", ".join(f"[[{canon_name(w)}]]" for w in d.get("sharedWith", []))
            url = d.get("sourceUrl", "")
            lines.append(f"- **{d.get('donorName','?')}** — shared with: {who}" + (f" ([source]({url}))" if url else ""))
    else:
        lines.append("- _(none)_")
    lines.append("")

    sc = data.get("sharedCommittees", [])
    lines += ["## Shared committees", ""]
    if sc:
        for c in sc:
            cn = c if isinstance(c, str) else json.dumps(c)
            lines.append(f"- {cn}")
    else:
        lines.append("- _(none)_")
    lines.append("")

    lines += ["## Compared against", ""]
    lines += [f"- [[{n}]]" for n in sorted(comp_names)]
    lines.append("")
    return "\n".join(lines), name, comp_names


def member_note(name, member_id):
    return (
        "---\n"
        f"name: {name}\n"
        f"member_id: {member_id}\n"
        "tags: [civiclens, member]\n"
        "---\n\n"
        f"# {name}\n\n"
        f"Member of Congress tracked by [[CivicLens]].\n\n"
        f"- Connection map: [[{member_id}|{name} — Connection Map]]\n\n"
        "## Backlinks\n\n"
        "Connections, shared donors, and committee overlaps surface automatically "
        "in the Obsidian backlinks pane and graph view.\n"
    )


def main():
    os.makedirs(CONN_DIR, exist_ok=True)
    os.makedirs(MEM_DIR, exist_ok=True)
    best = latest_per_member()

    # Remove the stale Sanders alias file if present.
    stale = os.path.join(CONN_DIR, "bernard-sanders.md")
    if os.path.exists(stale):
        os.remove(stale)

    all_names = {}
    for mid, (path, data) in best.items():
        body, name, comp = render(mid, data)
        open(os.path.join(CONN_DIR, f"{mid}.md"), "w").write(body)
        all_names[name] = mid
        for cn in comp:
            all_names.setdefault(cn, None)

    # Member stub per name we have an id for (so [[Name]] resolves to a real node).
    for name, mid in all_names.items():
        if mid is None:
            continue
        open(os.path.join(MEM_DIR, f"{name}.md"), "w").write(member_note(name, mid))

    print(f"connections: {len(best)} notes -> {CONN_DIR}")
    print(f"members:     {sum(1 for v in all_names.values() if v)} notes -> {MEM_DIR}")
    print(f"generated:   {datetime.date.today().isoformat()}")


if __name__ == "__main__":
    main()
