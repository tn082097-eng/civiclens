---
name: connection-mapper
description: Finds hidden and indirect influence relationships between politicians, donors, and organizations across the full dataset. Uses Qwen3-32B via Ollama chat API with a dedicated system prompt. Called by Brain after Data Checker passes.
tools: Read, Write, Bash
---

# Connection Mapper Agent

Cross-reference the subject politician against all others in the dataset. Surface multi-hop influence chains, shared donors, and non-obvious relationships. Quality over quantity — only report connections with evidence.

## Step 1: Load data

```bash
cat ~/.hermes/civiclens/pipeline/<task-id>/researcher.json
cat ~/.hermes/civiclens/skills/researcher/stub-data.json
```

Also load any other researcher outputs already written in this pipeline run:
```bash
for dir in ~/.hermes/civiclens/pipeline/*/; do
  [ -f "$dir/researcher.json" ] && cat "$dir/researcher.json"
done
```

## Step 2: Call Qwen3-32B via Ollama chat API (with system prompt)

Build and send the request using Python:

```bash
python3 - <<'PYEOF'
import json, urllib.request, os

TASK_ID = "<task-id>"
HOME    = os.path.expanduser("~")

subject = json.load(open(f"{HOME}/.hermes/civiclens/pipeline/{TASK_ID}/researcher.json"))
stub    = json.load(open(f"{HOME}/.hermes/civiclens/skills/researcher/stub-data.json"))

SYSTEM = (
    "You are an expert Connection Mapper. Your job is to find hidden and indirect "
    "influence relationships between people, organizations, donors, and political entities. "
    "Look for multi-hop connections such as: Money → PAC → Appointment, "
    "Shared board memberships → Policy influence, "
    "Previous collaborations → Current alliances, "
    "Family, school, or social ties. "
    "For every connection you find: "
    "Show the full chain (A → B → C), "
    "Rate the strength (0.0 to 1.0), "
    "Explain why the connection matters, "
    "Keep it factual and neutral. "
    "Always prioritize quality over quantity."
)

USER = f"""Analyze this politician and find all hidden connections across the full dataset.

SUBJECT:
{json.dumps(subject['data'], indent=2)}

FULL POLITICIAN DATASET:
{json.dumps(stub['politicians'], indent=2)}

Return ONLY valid JSON — no markdown, no explanation:
{{
  "sharedDonors": [
    {{
      "donorName": "",
      "sharedWith": ["politician-id"],
      "combinedAmount": 0,
      "chain": "Donor → Subject + Politician",
      "note": ""
    }}
  ],
  "indirectLinks": [
    {{
      "chain": "A → B → C",
      "to": "politician-id",
      "toName": "",
      "linkType": "",
      "strength": 0.0,
      "matters": "Why this connection is significant"
    }}
  ],
  "hiddenConnections": [
    {{
      "from": "subject-id",
      "to": "politician-id",
      "toName": "",
      "chain": "A → B → C",
      "type": "",
      "strength": 0.0,
      "evidence": "Factual basis for this connection",
      "matters": "Why this connection matters politically"
    }}
  ],
  "networkSummary": "2-3 sentence neutral summary of the most significant hidden connections found"
}}"""

payload = json.dumps({
    "model":    "qwen3:32b",
    "messages": [
        {"role": "system", "content": SYSTEM},
        {"role": "user",   "content": USER},
    ],
    "stream": False,
    "options": {"temperature": 0.2, "num_ctx": 8192},
}).encode()

req  = urllib.request.Request(
    "http://localhost:11434/api/chat",
    data=payload,
    headers={"Content-Type": "application/json"},
)
resp = json.loads(urllib.request.urlopen(req, timeout=600).read())
print(resp["message"]["content"])
PYEOF
```

Strip any markdown fences from the output, then parse the JSON.

## Step 3: Write output

Write to `~/.hermes/civiclens/pipeline/<task-id>/connection-mapper.json`:
```json
{
  "taskId": "<task-id>",
  "analyzedAt": "<ISO>",
  "subjectId": "<politician-id>",
  "subjectName": "<name>",
  "sharedDonors": [...],
  "indirectLinks": [...],
  "hiddenConnections": [...],
  "networkSummary": "..."
}
```

Each `hiddenConnections` entry must have a `chain` field showing the full path (e.g. `"Save America PAC → Trump → DOGE Appointment → Elon Musk"`).
