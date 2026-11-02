"""Real API token probes and refusal oracles. Restricted to one new inactive guard."""
import ast,hashlib,json,os,shutil,subprocess,sys,time,urllib.request,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
from native_process_info import information,terminate_owned
from native_token_probe import probe
p=json.loads((ROOT/'prepared.json').read_text())
root=Path(p['root']);control=Path(p['control']);node=Path(p['node']);python=Path(p['python'])
RUN=ROOT/'runs'/(root.name+'-qualification');RUN.mkdir(parents=True,exist_ok=False)
profile=json.loads((root/'profile.json').read_text())
assert profile['disposable'] is True and profile['root']==str(root)
assert root.name.startswith('p03-api-guarded-') and {p['api_port'],p['health_port']}.isdisjoint({4317,4318,58257})
result={'root':str(root),'profile':p['profile'],'cases':[],'installed_modified':False,'provider_emissions':0}
boot=None;serial=0
def save(): (RUN/'qualification.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def entries():
    file=Path(p['trace'])
    return [json.loads(line) for line in file.read_text().splitlines() if line.strip()] if file.exists() else []
def flags():
    global serial
    serial+=1
    for name in ('supervisor.pause','watchdog.stop','stop.request'):
        file=control/name
        if file.exists():file.rename(RUN/(str(serial)+'-'+name))
def start(name):
    global boot
    flags()
    log=(RUN/(name+'.log')).open('wb')
    boot=subprocess.Popen([str(python),'-I','-B',str(control/'boot_watchdog.py')],cwd=control,
        stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
    log.close()
def ready(minimum):
    deadline=time.monotonic()+100
    while time.monotonic()<deadline:
        if boot.poll() is not None:raise RuntimeError('Boot stopped before ready: '+str(boot.returncode))
        try:
            with urllib.request.urlopen('http://127.0.0.1:'+str(p['health_port'])+'/healthz',timeout=15) as response:health=json.load(response)
            if health['status']=='ready' and len(entries())>=minimum:
                owner=json.loads((root/'state/queue/owner.lock').read_text())
                assert owner['pid']==health['pid']
                info=information(health['pid'])
                assert info['is_appcontainer'] and info['appcontainer_sid']==p['appcontainer_sid']
                assert info['integrity_sid']=='S-1-16-4096' and info['capability_count']==0 and info['token_type']==1
                assert Path(info['image']).resolve()==node.resolve()
                assert all(entry['node']=='22.23.4' and Path(entry['executable']).resolve()==node.resolve() for entry in entries())
                return health,info
        except OSError:time.sleep(.3)
    raise RuntimeError('Qualified API ready timeout')
def stop():
    global boot
    (control/'supervisor.pause').write_text('Qualification only')
    (control/'stop.request').write_text('Qualification stop')
    deadline=time.monotonic()+35
    while (root/'state/queue/owner.lock').exists() and time.monotonic()<deadline:time.sleep(.2)
    (control/'watchdog.stop').write_text('Qualification stop')
    if boot is not None:
        assert boot.wait(timeout=45)==0
        boot=None
    assert not (root/'state/queue/owner.lock').exists()
def accesses(health):
    cases=[]
    targets=[('qualification-key',root/'authority/qualification.key'),
      ('financial-witness-key',control/'secrets/financial-release-authority.key'),
      ('registry-key',control/'recovery/workspace-api/provider-registry.key'),
      ('code',root/'code/api/dist/index.js'),('code-node',node),
      ('authority-program',control/'api_supervisor.py')]
    for label,path in targets:
        if not label.startswith('code'):cases.append((label+'-read',path,0x80000000))
        for suffix,access in [('write',0x40000000),('write-dac',0x40000),('write-owner',0x80000),('delete',0x10000)]:
            cases.append((label+'-'+suffix,path,access))
    cases.extend([('code-read-positive',root/'code/api/dist/index.js',0x80000000),
      ('state-write-positive',Path(p['trace']),0x40000000),('code-dir-add-file',root/'code',2),
      ('code-dir-delete-child',root/'code',0x40),('code-dir-dac',root/'code',0x40000),('code-dir-owner',root/'code',0x80000)])
    verdict=probe(health['pid'],cases)
    assert verdict['result']=='PASS'
    return verdict
def refused(name,expected,marker=None):
    flags();count=len(entries())
    run=subprocess.run([str(python),'-I','-B',str(control/'boot_watchdog.py')],cwd=control,capture_output=True,text=True,timeout=60)
    verdict={'case':name,'returncode':run.returncode,'stdout':run.stdout,'stderr':run.stderr,
      'entry_count_before':count,'entry_count_after':len(entries()),'marker_present':marker.exists() if marker else False}
    result['cases'].append(verdict);save()
    assert run.returncode!=0 and expected in run.stderr
    assert len(entries())==count and not verdict['marker_present']
def prefix_python(original,marker):
    text=original.decode('utf-8');lines=text.splitlines(keepends=True);tree=ast.parse(text);line=0
    for item in tree.body:
        if isinstance(item,ast.Expr) and isinstance(item.value,ast.Constant) and isinstance(item.value.value,str):line=item.end_lineno;continue
        if isinstance(item,ast.ImportFrom) and item.module=='__future__':line=item.end_lineno;continue
        break
    prefix='from pathlib import Path as __p03_path\n__p03_path('+repr(str(marker))+').write_text("positive-control")\nraise RuntimeError("POSITIVE_CONTROL_ONLY")\n'
    changed=(''.join(lines[:line])+prefix+''.join(lines[line:])).encode();ast.parse(changed)
    return changed
try:
    baseline=len(entries());start('initial');health,info=ready(baseline+1)
    result['cases'].append({'case':'nominal','health':health,'native_process':info,'effective_token_accesses':accesses(health)});save()
    terminate_owned(health['pid'],node,p['appcontainer_sid'])
    health2,info2=ready(baseline+2)
    assert info2['token_id_bytes']!=info['token_id_bytes']
    result['cases'].append({'case':'automatic-restart','health':health2,'native_process':info2,'effective_token_accesses':accesses(health2)});save()
    stop();start('reopened-authority');health3,info3=ready(baseline+3)
    result['cases'].append({'case':'fresh-authority-process','health':health3,'native_process':info3,'effective_token_accesses':accesses(health3)});save();stop()
    original=node.read_bytes();metadata=node.stat()
    wrong=Path('C:/Users/dbele/AppData/Local/nvm/v24.18.0/node.exe')
    version=subprocess.run([str(wrong),'--version'],capture_output=True,text=True,check=True).stdout.strip();assert version=='v24.18.0'
    try:
        node.write_bytes(wrong.read_bytes());refused('node24-before-entry','Node 22.23.4')
        result['node24']={'version':version,'sha256':digest(node)};save()
    finally:node.write_bytes(original);os.utime(node,ns=(metadata.st_atime_ns,metadata.st_mtime_ns))
    api=root/'code/api/dist/index.js';original=api.read_bytes();metadata=api.stat();marker=root/'state/api-tampered.marker'
    changed=('import __p03_fs from "node:fs"; __p03_fs.writeFileSync('+json.dumps(str(marker))+',"positive-control"); throw new Error("POSITIVE_CONTROL_ONLY");\n').encode()+original
    positive=RUN/'positive-api';shutil.copytree(root/'code/api',positive)
    try:
        api.write_bytes(changed)
        subprocess.run([str(node),'--check',str(api)],capture_output=True,check=True)
        refused('compiled-api-before-entry','Qualified API code or protection changed',marker)
        (positive/'dist/index.js').write_bytes(changed)
        assert digest(positive/'dist/index.js')==digest(api)
        run=subprocess.run([str(node),str(positive/'dist/index.js')],capture_output=True,text=True)
        assert run.returncode!=0 and marker.exists() and 'POSITIVE_CONTROL_ONLY' in run.stderr
        result['cases'].append({'case':'api-positive-control','same_bytes_sha256':digest(api),'marker_created':True,'returncode':run.returncode});save()
    finally:api.write_bytes(original);os.utime(api,ns=(metadata.st_atime_ns,metadata.st_mtime_ns))
    sdk=root/'authority/runtime/Lib/site-packages/voice_calibration/__init__.py'
    original=sdk.read_bytes();metadata=sdk.stat();marker=root/'state/mcp-tampered.marker';changed=prefix_python(original,marker)
    try:
        sdk.write_bytes(changed);refused('mcp-source-before-import','Independent controller code, caches or protection changed',marker)
        positive=RUN/'positive-mcp.py';positive.write_bytes(changed)
        run=subprocess.run([str(python),'-I','-B',str(positive)],capture_output=True,text=True)
        assert run.returncode!=0 and marker.exists() and 'POSITIVE_CONTROL_ONLY' in run.stderr
        result['cases'].append({'case':'mcp-positive-control','same_bytes_sha256':digest(sdk),'marker_created':True,'returncode':run.returncode});save()
    finally:sdk.write_bytes(original);os.utime(sdk,ns=(metadata.st_atime_ns,metadata.st_mtime_ns))
    cache=sdk.parent/'__pycache__';assert not cache.exists()
    cache.mkdir();(cache/'unexpected.cpython-312.pyc').write_bytes(b'Unexpected cache must never reach a business import')
    try:refused('mcp-cache-before-import','Loose Python caches are forbidden')
    finally:
        assert cache.resolve().is_relative_to(root.resolve())
        destination=RUN/'retained-unexpected-cache';assert not destination.exists();cache.rename(destination)
    start('restored');health4,info4=ready(baseline+4)
    result['cases'].append({'case':'restored-after-counterproofs','health':health4,'native_process':info4,'effective_token_accesses':accesses(health4)});save();stop()
    result['result']='PASS'
except BaseException as error:
    result['result']='FAIL';result['error']=repr(error);save();raise
finally:
    if boot is not None:
        try:stop()
        except BaseException as error:result['stop_error']=repr(error)
    save()
print(json.dumps({'result':result['result'],'root':str(root),'cases':len(result['cases']),'entries':len(entries()),'report':str(RUN/'qualification.json')}))
