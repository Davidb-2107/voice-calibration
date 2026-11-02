import hashlib,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent
OUTER=ROOT.parents[2]
SOURCE=OUTER/'.scratch/p03-worktrees/p03-internal-finance-service'
OP=SOURCE/'docs/validation/provider-registry-session/preproduction'
sys.path.insert(0,str(OP))
from windows_api_candidate import WindowsApiCandidate
from api_authority import verify
p=json.loads((ROOT/'prepared.json').read_text())
guard=WindowsApiCandidate.open(Path(p['root']))
locks=[]
try:
    verify(guard,locks)
finally:
    for handle in locks:guard._api.kernel.CloseHandle(handle)
matches=[]
for folder in (guard.root/'authority/control',guard.root/'code'):
    for file in folder.iterdir():
        source=OP/file.name
        if file.suffix in ('.py','.mjs') and source.is_file() and not file.name.startswith('test_'):
            actual=hashlib.sha256(file.read_bytes()).hexdigest()
            expected=hashlib.sha256(source.read_bytes()).hexdigest()
            assert actual==expected,str(file)
            matches.append({'file':str(file.relative_to(guard.root)),'sha256':actual})
frozen=OUTER/'.scratch/p03-integration/installed-freeze-20261101/frozen'
manifest=frozen/'manifest.json'
assert hashlib.sha256(manifest.read_bytes()).hexdigest()=='28728e95d0a5c02749dc519eba1595739428de6869e76e3f5c2a46a847c845f5'
artifacts=json.loads(manifest.read_text())['artifacts']
for item in artifacts:
    file=frozen/item['path']
    assert file.stat().st_size==item['bytes']
    assert hashlib.sha256(file.read_bytes()).hexdigest()==item['sha256'],str(file)
cache_files=[str(file.relative_to(guard.root)) for root in (guard.root/'code',guard.root/'authority')
    for file in root.rglob('*') if file.name=='__pycache__' or file.suffix in ('.pyc','.pyo')]
assert not cache_files,cache_files
report={'result':'PASS','root':p['root'],'qualified_seals_and_all_immutable_inventory':'PASS',
    'source_matches_qualified_programs':matches,'python_cache_policy':'stdlib-zip-only-v1',
    'loose_bytecode_or_cache_directories':cache_files,'historical_artifacts_verified':len(artifacts),
    'historical_artifact_bytes':sum(item['bytes'] for item in artifacts),
    'original_manifest_sha256':hashlib.sha256(manifest.read_bytes()).hexdigest(),
    'candidate_manifest_sha256':hashlib.sha256((guard.root/'authority/api-controller.json').read_bytes()).hexdigest(),
    'native_manifest_sha256':hashlib.sha256((guard.root/'authority/target.json').read_bytes()).hexdigest(),
    'node_exe_sha256':hashlib.sha256(Path(p['node']).read_bytes()).hexdigest(),
    'python_exe_sha256':hashlib.sha256(Path(p['python']).read_bytes()).hexdigest(),
    'installed_writes':False,'provider_emissions':0}
(ROOT/'final-footprint.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k!='source_matches_qualified_programs'}),flush=True)
