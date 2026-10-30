"""Stage, verify and activate one immutable local simulated API release."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import uuid
import install_provider_registry as installer
from restore import write_record


def fingerprint(directory):
    files = sorted(directory.rglob('*'))
    if any(p.is_symlink() for p in files):
        raise RuntimeError('Linked release entries are forbidden')
    digest = hashlib.sha256()
    for path in files:
        if not path.is_file():
            continue
        name = path.relative_to(directory).as_posix().encode('utf-8')
        contents = path.read_bytes()
        # Frame both fields so bytes cannot move between names, contents or files.
        digest.update(len(name).to_bytes(8, 'big'))
        digest.update(name)
        digest.update(len(contents).to_bytes(8, 'big'))
        digest.update(contents)
    return digest.hexdigest()


def runtime_fingerprint(directory):
    package = directory/'package.json'
    if package.is_symlink() or not package.is_file():
        raise RuntimeError('Release package runtime identity missing or linked')
    digest = hashlib.sha256()
    for value in [fingerprint(directory/'dist').encode('ascii'), package.read_bytes()]:
        digest.update(len(value).to_bytes(8, 'big'))
        digest.update(value)
    return digest.hexdigest()


def load_release(directory):
    directory = directory.resolve()
    manifest = json.loads((directory/'manifest.json').read_text())
    if not manifest.get('runtimeHash'):
        raise RuntimeError('Release runtime identity missing; stage and validate a new release')
    if (manifest['module'] != str(directory/'dist/index.js')
            or manifest['compiledHash'] != fingerprint(directory/'dist')
            or manifest['runtimeHash'] != runtime_fingerprint(directory)
            or manifest['releaseId'] != 'local-'+manifest['runtimeHash']):
        raise RuntimeError('Release content or module identity mismatch')
    return manifest


def stage(source, root, base_commit):
    directory = root/'releases'/('api-'+uuid.uuid4().hex)
    directory.mkdir(parents=True)
    shutil.copytree(source/'dist', directory/'dist')
    shutil.copyfile(source/'package.json', directory/'package.json')
    digest = fingerprint(directory/'dist')
    runtime_digest = runtime_fingerprint(directory)
    manifest = {'releaseId':'local-'+runtime_digest,'compiledHash':digest,'runtimeHash':runtime_digest,'baseCommit':base_commit,
                'committed':False,'module':str((directory/'dist/index.js').resolve()),'source':str(source.resolve())}
    write_record(directory/'manifest.json',manifest)
    return directory.resolve()


def report(directory, kind, result):
    manifest = load_release(directory)
    record = {**result,'kind':kind,'releaseId':manifest['releaseId'],'compiledHash':manifest['compiledHash'],
              'runtimeHash':manifest['runtimeHash'],
              'module':manifest['module'],'createdAt':datetime.now(timezone.utc).isoformat()}
    path = directory/'reports'/(kind+'-'+uuid.uuid4().hex+'.json')
    write_record(path,record)
    return path


def require_gates(directory, evidence):
    manifest = load_release(directory)
    proof = json.loads(evidence.read_text())
    if any(proof.get(k)!=manifest[k] for k in ['releaseId','compiledHash','runtimeHash','module']):
        raise RuntimeError('Validation belongs to another release')
    expected = {'node','browser','publication'}
    if proof.get('kind')!='gates' or proof.get('status')!='PASS' or proof.get('checks')!=dict.fromkeys(expected,'PASS'):
        raise RuntimeError('All release gates must pass before activation')
    return manifest


def _financial_reader():
    from voice_calibration.core.provider_registry import ProviderRegistry
    from voice_calibration.core.financial_compatibility import check_target, required_capabilities
    return ProviderRegistry, required_capabilities, check_target


def financial_preflight(root, directory, config=None):
    """Runs in the trusted control interpreter, before loading any target code.

    Never import this guard from the candidate's Python environment. Its reader
    and release-authority key belong to independent control, outside the target.
    """
    config_path = root/'config.json'
    if config is None:
        if not config_path.exists():
            return  # isolated legacy harness with no registered workspaces
        config = json.loads(config_path.read_text())
    manifest = load_release(directory)
    for workspace in config.get('workspaces', []):
        control = Path(workspace['engine']['restoreGuardDir'])
        registry_dir, registry_key = control/'provider-registry', control/'provider-registry.key'
        if not registry_dir.exists() and not registry_key.exists() and not config.get('providerRegistryRequired'):
            continue
        ProviderRegistry, required_capabilities, check_target = _financial_reader()
        registry = ProviderRegistry(registry_dir, registry_key, workspace['workspaceId'], workspace['tenantId'])
        if not required_capabilities(registry):
            continue
        # Root-owned key and reports are independent from candidate reports and
        # the freely writable candidate manifest. No compatible=true escape.
        key_path = root/'secrets'/'financial-release-authority.key'
        proof_path = root/'financial-targets'/(manifest['runtimeHash']+'.json')
        if key_path.is_symlink() or proof_path.is_symlink():
            raise RuntimeError('Linked financial release authority is forbidden')
        try:
            trust_key = key_path.read_bytes()
            attestation = json.loads(proof_path.read_text())
        except (OSError, ValueError) as error:
            raise RuntimeError('Financial target qualification unavailable; do not start') from error
        check_target(registry, artifact_sha256=manifest['runtimeHash'], engine_image=config.get('image'),
                     attestation=attestation, trust_key=trust_key)


def check(directory):
    manifest = load_release(directory)
    financial_preflight(directory.parent.parent, directory)
    source = Path(manifest['source'])
    if runtime_fingerprint(source)!=manifest['runtimeHash']:
        raise RuntimeError('Working build differs from immutable release')
    command = npm_command()
    checks = {}
    commands = [('node',command+['test']),('browser',command+['run','test:browser']),
                ('publication',[sys.executable,'-m','unittest','discover','-s',str(Path(__file__).parent),'-p','test_release*.py'])]
    for name,args in commands:
        logfile = directory/(name+'-'+uuid.uuid4().hex+'.log')
        with logfile.open('x',encoding='utf-8') as output:
            outcome = subprocess.run(args,cwd=source,stdout=output,stderr=subprocess.STDOUT,timeout=300)
        checks[name] = 'PASS' if outcome.returncode==0 else 'FAIL'
        if outcome.returncode:
            failed=report(directory,'gates',{'status':'FAIL','checks':checks,'log':str(logfile)})
            raise RuntimeError('Gate failed; inspect '+str(failed))
    if runtime_fingerprint(source)!=manifest['runtimeHash']:
        raise RuntimeError('Build changed during validation')
    return report(directory,'gates',{'status':'PASS','checks':checks})


def protected(config,root):
    locations={'data':Path(config['jobQueue']['dataDir']).parent,'recovery':Path(config['recoveryDir']),'secrets':root/'secrets'}
    values={}
    for name,folder in locations.items():
        for path in folder.rglob('*'):
            if path.is_symlink():raise RuntimeError('Linked protected data')
            if not path.is_file() or path.name in {'owner.lock','restore.lock'}:continue
            relative=path.relative_to(folder).as_posix();contents=path.read_bytes()
            if name=='data' and relative.startswith('queue/') and path.suffix=='.json':
                row=json.loads(contents);row.pop('updatedAt',None);contents=json.dumps(row,sort_keys=True).encode()
            values[name+'/'+relative]=hashlib.sha256(contents).hexdigest()
    return locations,values


def activate(root,directory,evidence):
    manifest=require_gates(directory,evidence)
    config=json.loads((root/'config.json').read_text())
    if config['host']!='127.0.0.1' or config['provider']!='simulated':raise RuntimeError('Only private simulated preproduction')
    financial_preflight(root, directory, config)
    subprocess.run([sys.executable,str(root/'control.py'),'stop'],check=True,capture_output=True,timeout=100)
    locations,before=protected(config,root)
    backup=root/'backups'/('release-'+uuid.uuid4().hex);backup.mkdir()
    for name,folder in locations.items():shutil.copytree(folder,backup/name)
    shutil.copyfile(root/'config.json',backup/'config.json')
    write_record(backup/'hashes.json',before)
    candidate={**config,'module':manifest['module'],'commit':manifest['releaseId'],
               'baseCommit':manifest['baseCommit'],'apiCandidateDir':str(directory),'localPatch':'local-api-candidate',
               'releaseDir':str(directory),'validationReport':str(evidence)}
    installer.HERE=root
    installer.install(candidate)
    if protected(candidate,root)[1]!=before:raise RuntimeError('Protected data changed before startup')
    financial_preflight(root, directory, candidate)
    subprocess.run([sys.executable,str(root/'control.py'),'start'],check=True,capture_output=True,timeout=100)
    with urllib.request.urlopen(f"http://127.0.0.1:{config['healthPort']}/healthz",timeout=30) as response:health=json.load(response)
    if health['status']!='ready' or health['commit']!=manifest['releaseId'] or not health['providerRegistry']['valid']:
        raise RuntimeError('Activated service health mismatch')
    if protected(candidate,root)[1]!=before:raise RuntimeError('Protected data changed during startup')
    return report(directory,'activation',{'status':'PASS','backup':str(backup),'evidence':str(evidence),
                  'protectedDataPreserved':True,'providerCalls':0,'committed':False})


def npm_command():
    npm=shutil.which('npm.cmd' if sys.platform=='win32' else 'npm')
    if not npm:raise RuntimeError('npm unavailable')
    return ['node',str(Path(npm).parent/'node_modules/npm/bin/npm-cli.js')] if sys.platform=='win32' else [npm]


def status(root):
    cfg=json.loads((root/'config.json').read_text())
    if any(not isinstance(cfg.get(key),str) or not cfg[key].strip()
           for key in ['releaseDir','validationReport','module','commit']):
        raise RuntimeError('Active release configuration missing')
    directory=Path(cfg['releaseDir'])
    manifest=load_release(directory)
    # Equivalent absolute paths identify the same module, including dot segments.
    if (Path(cfg['module']).resolve()!=Path(manifest['module']).resolve()
            or cfg['commit']!=manifest['releaseId']):
        raise RuntimeError('Active configuration differs from validated release')
    evidence=Path(cfg['validationReport'])
    require_gates(directory,evidence)
    financial_preflight(root, directory, cfg)
    return {'releaseId':manifest['releaseId'],'module':manifest['module'],
            'evidence':str(evidence),'committed':manifest['committed']}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='action',required=True)
    p=commands.add_parser('stage');p.add_argument('--source',type=Path,required=True);p.add_argument('--root',type=Path,required=True);p.add_argument('--base-commit',required=True)
    p=commands.add_parser('check');p.add_argument('--release',type=Path,required=True)
    p=commands.add_parser('activate');p.add_argument('--release',type=Path,required=True);p.add_argument('--root',type=Path,required=True);p.add_argument('--evidence',type=Path,required=True)
    p=commands.add_parser('status');p.add_argument('--root',type=Path,required=True)
    args=parser.parse_args()
    if args.action=='stage':
        subprocess.run(npm_command()+['run','build'],cwd=args.source,check=True,timeout=300)
        # Root-level isolation fixtures may contain intentionally broken junctions; check the configured code roots.
        targets=['src','test']+[p.name for p in sorted(args.source.glob('*.json'))]
        subprocess.run(npm_command()+['exec','--','biome','ci',*targets],cwd=args.source,check=True,timeout=300)
        result={'release':str(stage(args.source,args.root,args.base_commit))}
    elif args.action=='check':result={'report':str(check(args.release.resolve()))}
    elif args.action=='activate':result={'report':str(activate(args.root.resolve(),args.release.resolve(),args.evidence.resolve()))}
    else:result=status(args.root)
    print(json.dumps(result))


if __name__=='__main__':main()
