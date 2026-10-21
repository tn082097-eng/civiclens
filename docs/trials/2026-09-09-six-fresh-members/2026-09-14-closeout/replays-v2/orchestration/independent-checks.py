from pathlib import Path
import hashlib, json, subprocess, sys

n = sys.argv[1]
base = Path(__file__).parent
root = Path('/home/captainanime/Developer/civiclens-track-b')
ev = root / 'docs/trials/2026-09-09-six-fresh-members/2026-09-14-closeout/replays-v2' / ('s' + n)
setup = json.loads((ev / 'setup.json').read_text())
w = Path(setup['worktree'])
identity = json.loads((ev / 'identity.json').read_text())
slug, bio = identity['slug'], identity['bioguide']
outcomes = []

def step(label, cmd):
    path = ev / (label + '.json')
    if path.exists():
        result = json.loads(path.read_text())
        outcomes.append({'step': label, 'exit': result['exit'], 'existing': True})
        return result['exit']
    result = subprocess.run(['python3', str(base / 'run-step-v2.py'), n, label, *cmd])
    outcomes.append({'step': label, 'exit': result.returncode, 'existing': False})
    return result.returncode

if identity['chamber'] == 'house':
    for year in range(2023, 2027):
        folder = w / 'data/caches/pfd-cache' / str(year)
        if list(folder.glob('*.txt')):
            step('extract-' + str(year), ['node', '--import', 'tsx', 'skills/pfd-fetcher/extract.ts', str(folder)])
    step('house-pfd', ['node', '--import', 'tsx', 'agents/pipeline.ts', '--load-pfd', '2023,2024,2025,2026', '--bioguide', bio])
else:
    step('senate-ptr', ['node', '--import', 'tsx', 'agents/pipeline.ts', '--load-senate-ptr', '--bioguide', bio])

step('fec-ie', ['node', '--import', 'tsx', 'agents/pipeline.ts', '--load-fec-ie', '2026', '--bioguide', bio])
for label, cmd in [
    ('baseline-after', ['npm', 'run', 'verify:baseline']),
    ('corpus', ['npm', 'run', 'validate:corpus']),
    ('typecheck', ['./node_modules/.bin/tsc', '--noEmit']),
]:
    step(label, cmd)
files = json.loads((root / 'docs/trials/2026-09-09-six-fresh-members/2026-09-14-closeout/applicable-test-files-final.json').read_text())
step('tests', ['node', '--import', 'tsx', '--test', *files])
step('checkpoint', ['node', '--import', 'tsx', '--input-type=module', '-e', "import {getDb,closeDb} from './db/init.ts';const c=await getDb();await c.run('CHECKPOINT');closeDb();"])
step('db-audit-complete', ['node', str(base / 'audit-db-v2.mjs'), str(w), slug, bio])
manifest = [{'path': str(p.relative_to(w)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'bytes': p.stat().st_size}
    for folder in ['data/caches', 'pipeline'] for p in sorted((w / folder).rglob('*'))
    if p.is_file() and (folder != 'pipeline' or '/task-' in str(p) or '/artifacts/' in str(p))]
(ev / 'independent-output-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
(ev / 'independent-checks.json').write_text(json.dumps({'outcomes': outcomes,
    'scope': 'Independent disclosure and partial-state integrity checks; bill-dependent gates remain pending. This is not a passing stratum.',
    'openSecrets': 'not-collected'}, indent=2) + '\n')
print('INDEPENDENT CHECKS', n, outcomes)
