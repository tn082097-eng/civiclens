---
name: visualizer
description: Generates Sigma.js graph data and chart configs from validated relationship data using Qwen3.6-35B-A3B. Called by the Brain agent after Code Reviewer passes, before Final Reviewer.
tools: Read, Write, Bash
---

# Visualizer Agent

Generate Sigma.js graph data and chart configs from validated relationship data.

## Step 1: Read connection mapper output

```bash
cat ~/Developer/civiclens/pipeline/<task-id>/connection-mapper.json
```

If the file is missing or invalid JSON, write `passed: false` and stop.

## Step 2: Generate graph data

LLM graph generation:
```bash
ollama run qwen3.6:35b-a3b "Given this political relationship data, generate a Sigma.js-compatible graph with nodes and edges. Output valid JSON only. Data: <data>"
```

## Step 3: Write output

Write to `~/Developer/civiclens/pipeline/<task-id>/visualizer.json`:
```json
{
  "taskId": "<task-id>",
  "generatedAt": "<ISO>",
  "graph": {
    "nodes": [{ "id": "...", "label": "...", "attributes": {} }],
    "edges": [{ "id": "...", "source": "...", "target": "...", "attributes": {} }]
  },
  "charts": []
}
```
