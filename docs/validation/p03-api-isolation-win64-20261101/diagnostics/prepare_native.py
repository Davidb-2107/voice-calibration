"""Create only a fresh inactive API guard and synthetic workspace. No installed writes."""
import hashlib, importlib.util, json, os, shutil, socket, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT.parents[1]/'p03-worktrees/p03-internal-finance-service'
OP = SOURCE/'docs/validation/provider-registry-session/preproduction'
FROZEN = ROOT.parent/'installed-freeze-20261101/frozen'
PRE = Path('C:/Users/dbele/Documents/Codex/2026-10-07/referenced-chatgpt-conversation-this-is-an-3/preproduction')
TARGET = PRE/'releases/p03-api-guarded-20261101-r6'
sys.path.insert(0,str(OP))
from windows_api_candidate import WindowsApiCandidate
from api_authority import seal
from node_runtime import pinned_node

def save(path,value): path.write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8')
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

assert sha(FROZEN/'manifest.json') == '28728e95d0a5c02749dc519eba1595739428de6869e76e3f5c2a46a847c845f5'
manifest=json.loads((FROZEN/'manifest.json').read_text())
for item in manifest['artifacts']:
    assert sha(FROZEN/item['path']) == item['sha256']
spec=importlib.util.spec_from_file_location('previous_stage',ROOT.parent/'api-supervised-qualification-20261101/stage_api.py')
stage=importlib.util.module_from_spec(spec);spec.loader.exec_module(stage)
guard=WindowsApiCandidate.create(TARGET)
control=guard._authority/'control';control.mkdir()
for path in OP.iterdir():
    if path.suffix in ('.py','.mjs') and not path.name.startswith('test_'):
        shutil.copyfile(path,control/path.name)
# Extract source packages without loose bytecode. Keep the official standard-library ZIP.
import stat,zipfile
destination=guard._authority/'runtime'
destination.mkdir()
skipped=[]
with zipfile.ZipFile(FROZEN/'artifacts/python-runtime-win-x64-3.12.10-portable.zip') as archive:
    names=set()
    for item in archive.infolist():
        relative=Path(item.filename)
        assert not relative.is_absolute() and '..' not in relative.parts and ':' not in item.filename and '\\' not in item.filename
        assert not stat.S_ISLNK(item.external_attr >> 16) and item.filename.casefold() not in names
        names.add(item.filename.casefold())
        if '__pycache__' in relative.parts or relative.suffix.lower() in ('.pyc','.pyo'):
            skipped.append(item.filename);continue
        target=destination/relative
        assert target.resolve().is_relative_to(destination.resolve())
        if item.is_dir():target.mkdir(parents=True,exist_ok=True)
        else:
            target.parent.mkdir(parents=True,exist_ok=True)
            with target.open('xb') as output:output.write(archive.read(item))
save(ROOT/'sdk-cache-filter-r6.json',{'policy':'stdlib-zip-only-v1','skipped':skipped,'original_archive_unchanged':True})
python=guard._authority/'runtime/python.exe'
pth=python.with_name('python312._pth')
if pth.exists():
    text=pth.read_text(encoding='utf-8-sig')
    pth.write_text('\n'.join(line for line in text.splitlines() if line.strip()!='import site')+'\n',encoding='utf-8')
node=guard.code/'node.exe'
import zipfile
with zipfile.ZipFile(FROZEN/'artifacts/node-v22.23.4-win-x64.zip') as archive:
    node.write_bytes(archive.read('node-v22.23.4-win-x64/node.exe'))
pinned_node(str(node))
for base in (guard.code/'api',guard._authority/'broker-api'):
    base.mkdir()
    shutil.copytree(ROOT/'build-service/dist',base/'dist')
    shutil.copyfile(SOURCE/'package.json',base/'package.json')
for name in ('api_worker.mjs','private_channel.mjs'):
    shutil.copyfile(OP/name,guard.code/name)
root=guard.state/'workspaces/workspace-api'
for path in (root/'ui',root/'state',root/'corpus',guard.state/'queue',control/'recovery/workspace-api',control/'secrets'):
    path.mkdir(parents=True)
(root/'corpus/voice_wpm.json').write_text('{}\n',encoding='utf-8')
(control/'secrets/financial-release-authority.key').write_bytes(os.urandom(32))
sockets=[socket.socket(),socket.socket()]
for connection in sockets: connection.bind(('127.0.0.1',0))
api_port,health_port=[connection.getsockname()[1] for connection in sockets]
for connection in sockets: connection.close()
assert len({api_port,health_port,4317,4318,58257})==5
old=PRE/'releases/p03-24ceb431-6f9361ce-api-native'
old_config=json.loads((old/'config.json').read_text())
boot=json.loads((old/'boot-runtime.json').read_text())
sys.path.insert(0,str(control))
import release
api_dir=guard.code/'api'
compiled=release.fingerprint(api_dir/'dist')
runtime=release.runtime_fingerprint(api_dir)
record={'releaseId':'local-'+runtime,'compiledHash':compiled,'runtimeHash':runtime,'baseCommit':'24ceb431049cf88fe51e11a7349db2b0d06a46c9','committed':False,
    'module':str(api_dir/'dist/index.js'),'source':str(api_dir),'qualificationOnly':True}
save(api_dir/'manifest.json',record)
workspace={'workspaceId':'workspace-api','tenantId':'tenant-qualification','dataDir':str(root/'ui'),
    'stateDir':str(root/'state'),'wpmPath':str(root/'corpus/voice_wpm.json'),'credentials':{'env':{}},
    'engine':{'root':str(root),'workspaceId':'workspace-api','tenantId':'tenant-qualification',
      'wpmPath':str(root/'corpus/voice_wpm.json'),'stateDir':str(root/'state'),
      'uiWorkspaceDir':str(root/'ui/workspaces/workspace-api'),'restoreGuardDir':str(control/'recovery/workspace-api')}}
config={'host':'127.0.0.1','provider':'simulated','apiPort':api_port,'healthPort':health_port,
    'commit':record['releaseId'],'module':record['module'],'releaseDir':str(api_dir),'image':manifest['engine']['candidate_image'],
    'registryPython':str(python),'providerRegistryRequired':True,'recoveryDir':str(control/'recovery'),
    'jobQueue':{'dataDir':str(guard.state/'queue')},'workspaces':[workspace],'supabase':old_config['supabase'],
    'localPatch':'inactive-appcontainer-api-qualification','windowsApiRoot':str(guard.root),
    'brokerModule':str(guard._authority/'broker-api/dist/index.js')}
save(control/'config.json',config)
save(control/'boot-runtime.json',{'python':str(python),'node':str(node),'docker':boot['docker'],'dockerConfig':boot['dockerConfig']})
public={key:config[key] for key in ('host','apiPort','module','image','jobQueue','supabase')}
handle=guard.code/'guard-handles'/workspace['workspaceId']
handle.mkdir(parents=True)
public_workspace={key:value for key,value in workspace.items() if key!='credentials'}
public_workspace['engine']={**workspace['engine'],'restoreGuardDir':str(handle)}
public['workspaces']=[public_workspace]
for path in [guard.state,*guard.state.rglob('*')]:guard._protect(path,'state')
public['controlConfigSha256']=sha(control/'config.json')
save(guard.code/'api-public.json',public)
entry=guard.code/'entry.mjs'
trace=guard.state/'business-entry.trace'
entry.write_text('import fs from "node:fs";\nfs.appendFileSync('+json.dumps(str(trace))+',JSON.stringify({pid:process.pid,node:process.versions.node,executable:process.execPath})+"\\n");\nawait import("./api_worker.mjs");\n',encoding='utf-8')
plan={'root':str(guard.root),'control':str(control),'python':str(python),'node':str(node),
    'api_port':api_port,'health_port':health_port,'profile':guard._profile,'appcontainer_sid':guard.appcontainer_sid,
    'api_runtime_hash':runtime,'trace':str(trace),'source':str(SOURCE),'installed_modified':False}
save(ROOT/'prepared.json',plan)
initialize=ROOT/'initialize_native.py'
run=subprocess.run([str(python),'-I','-B',str(initialize)],capture_output=True,text=True)
save(ROOT/'initialize-result.json',{'returncode':run.returncode,'stdout':run.stdout,'stderr':run.stderr})
if run.returncode: raise RuntimeError(run.stderr)
for path in (control/'recovery').rglob('*'):
    guard._protect(path,'authority')
for path in [control/'secrets',*list((control/'secrets').iterdir())]:guard._protect(path,'authority')
guard.qualify([str(node),'--preserve-symlinks','--preserve-symlinks-main',str(entry)])
roots=['authority/runtime','authority/broker-api']
roots.extend(path.relative_to(guard.root).as_posix() for path in control.iterdir() if path.is_file() and path.suffix in ('.py','.mjs','.json'))
seal(guard,roots)
save(ROOT/'prepared.json',plan)
print(json.dumps(plan))
