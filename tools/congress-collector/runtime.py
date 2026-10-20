#!/usr/bin/env python3
"""Isolated, hash-locked wheel resolution and offline collector runtime setup."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, ProxyHandler, Request

HERE = Path(__file__).resolve().parent
COMMIT = '8184bcb13160da2389dea4c902de67817db681fc'
VENDOR = HERE / 'vendor/unitedstates-congress-8184bcb'
LOCK = HERE / 'requirements.lock'
FILES = {'LICENSE','congress/__init__.py','congress/tasks/__init__.py','congress/tasks/utils.py','congress/tasks/vote_info.py'}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_vendor(root=VENDOR):
    root = Path(root)
    manifest = json.loads((root / 'VENDOR.json').read_text())
    if manifest.get('commit') != COMMIT or set(manifest.get('files', {})) != FILES:
        raise ValueError('vendor manifest identity/files mismatch')
    for name, entry in manifest['files'].items():
        file = root / name
        if file.stat().st_size != entry['bytes'] or digest(file) != entry['sha256']:
            raise ValueError(f'vendor hash mismatch: {name}')
    return manifest


def interfaces():
    return sorted(line.split(':')[0].strip() for line in Path('/proc/self/net/dev').read_text().splitlines() if ':' in line)


def require_offline():
    found = interfaces()
    if set(found) - {'lo'}:
        raise ValueError('network namespace must contain only loopback: ' + ','.join(found))
    return found


def runtime_dir(value=None):
    return Path(value or os.environ.get('CIVICLENS_COLLECTOR_RUNTIME') or HERE / '.runtime').resolve()


def minimal_env(tmp):
    return {'PATH':'/usr/bin:/bin','HOME':str(tmp),'TMPDIR':str(tmp),'LANG':'C.UTF-8','PIP_CONFIG_FILE':'/dev/null','PIP_NO_INPUT':'1'}


def check_runtime(value=None):
    root = runtime_dir(value)
    if not (root / 'venv/bin/python').is_file() or not (root / 'runtime.json').is_file():
        raise ValueError(f'runtime missing: {root}')
    data = json.loads((root / 'runtime.json').read_text())
    verify_vendor()
    if data.get('lock_sha256') != digest(LOCK) or data.get('vendor_manifest_sha256') != digest(VENDOR / 'VENDOR.json'):
        raise ValueError('runtime stale: lock or vendor manifest changed')
    if not isinstance(data.get('packages'), dict) or not isinstance(data.get('python'), str):
        raise ValueError('runtime stale: malformed metadata')
    return data


def run(cmd, tmp):
    subprocess.run([str(c) for c in cmd], check=True, cwd=tmp, env=minimal_env(tmp))


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('wheel download redirect refused')


def resolve(scratch):
    scratch = Path(scratch).resolve()
    scratch.mkdir(parents=True, exist_ok=False)
    home = scratch / 'home'; home.mkdir()
    venv = scratch / 'venv'
    run([sys.executable,'-I','-B','-m','venv',venv], home)
    python = venv / 'bin/python'
    report = scratch / 'pip-report.json'
    run([python,'-I','-B','-m','pip','install','--dry-run','--ignore-installed','--report',report,'--index-url','https://pypi.org/simple','--only-binary=:all:','--no-cache-dir','--keyring-provider','disabled','lxml','pytz','scrapelib'],home)
    data = json.loads(report.read_text())
    wheelhouse = scratch / 'wheelhouse'; wheelhouse.mkdir()
    receipts=[]; lines=['# Index: https://pypi.org/simple',f'# Resolved {datetime.now(timezone.utc).date().isoformat()}; CPython 3.12 Linux x86_64; binary wheels only.']
    opener=build_opener(ProxyHandler({}),NoRedirect())
    for item in data['install']:
        url=item['download_info']['url']; split=urlsplit(url); filename=Path(split.path).name
        if split.scheme!='https' or split.hostname!='files.pythonhosted.org' or not filename.endswith('.whl'):
            raise ValueError(f'not an authorized binary wheel URL: {url}')
        expected=item['download_info']['archive_info']['hashes']['sha256']
        with opener.open(Request(url),timeout=60) as response:
            body=response.read()
        actual=hashlib.sha256(body).hexdigest()
        if actual!=expected: raise ValueError(f'wheel hash mismatch: {filename}')
        (wheelhouse/filename).write_bytes(body)
        name=item['metadata']['name']; version=item['metadata']['version']
        receipts.append(dict(name=name,version=version,url=url,filename=filename,sha256=actual,bytes=len(body)))
        lines.append(f'{name}=={version} --hash=sha256:{actual}')
    (scratch/'resolution-receipts.json').write_text(json.dumps(receipts,indent=2)+'\n')
    LOCK.write_text('\n'.join(lines)+'\n')
    return {'wheelhouse':str(wheelhouse),'receipts':str(scratch/'resolution-receipts.json'),'lock_sha256':digest(LOCK)}


def install(wheelhouse, value=None):
    require_offline(); verify_vendor()
    root=runtime_dir(value); root.mkdir(parents=True,exist_ok=True)
    venv=root/'venv'
    if venv.exists(): raise ValueError(f'refusing existing venv: {venv}')
    source=Path(wheelhouse).resolve(); dest=root/'wheelhouse'
    if source!=dest:
        shutil.copytree(source,dest,dirs_exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='collector-install-') as tmp:
        run([sys.executable,'-I','-B','-m','venv',venv],tmp)
        python=venv/'bin/python'
        run([python,'-I','-B','-m','pip','install','--no-index','--find-links',dest,'--require-hashes','--only-binary=:all:','--no-deps','-r',LOCK],tmp)
        probe=subprocess.run([str(python),'-I','-B','-c','import importlib.metadata as m,json,platform; print(json.dumps({"python":platform.python_version(),"packages":{d.metadata["Name"]:d.version for d in m.distributions() if d.metadata["Name"].lower()!="pip"}}))'],cwd=tmp,env=minimal_env(tmp),text=True,capture_output=True,check=True)
        metadata=json.loads(probe.stdout)
    metadata.update(lock_sha256=digest(LOCK),vendor_manifest_sha256=digest(VENDOR/'VENDOR.json'),created_at=datetime.now(timezone.utc).isoformat())
    (root/'runtime.json').write_text(json.dumps(metadata,indent=2)+'\n')
    return metadata


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    subs=parser.add_subparsers(dest='command',required=True)
    p=subs.add_parser('resolve');p.add_argument('--scratch',required=True)
    p=subs.add_parser('install');p.add_argument('--wheelhouse',required=True);p.add_argument('--runtime-dir')
    p=subs.add_parser('check');p.add_argument('--runtime-dir')
    args=parser.parse_args()
    try:
        if args.command=='resolve': result=resolve(args.scratch)
        elif args.command=='install':result=install(args.wheelhouse,args.runtime_dir)
        else:result=check_runtime(args.runtime_dir)
        print(json.dumps(result,indent=2))
    except Exception as exc:
        print(json.dumps({'status':'failed','reason':f'{type(exc).__name__}: {exc}'}),file=sys.stderr)
        return 1
    return 0


if __name__=='__main__':sys.exit(main())
