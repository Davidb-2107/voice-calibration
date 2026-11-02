import importlib.util,json,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('stage',ROOT.parent/'api-supervised-qualification-20261101/stage_api.py')
stage=importlib.util.module_from_spec(spec);spec.loader.exec_module(stage)
target=ROOT/'test-python'
stage.extract(ROOT.parent/'installed-freeze-20261101/frozen/artifacts/python-runtime-win-x64-3.12.10-portable.zip',target)
module=target/'Lib/site-packages/p03_cache_fixture.py'
module.write_text('value = "SOURCE"\n',encoding='utf-8')
payload=ROOT/'cache_payload.py'
marker=ROOT/'cache-executed.marker'
payload.write_text('from pathlib import Path\nPath('+repr(str(marker))+').write_text("UNQUALIFIED_CACHE_LOADED")\nraise RuntimeError("UNQUALIFIED_CACHE_LOADED")\n',encoding='utf-8')
compiler=ROOT/'compile_cache_fixture.py'
compiler.write_text('import py_compile,sys\nfrom pathlib import Path\nroot=Path(__file__).resolve().parent\nmodule=root/"test-python/Lib/site-packages/p03_cache_fixture.py"\ncache=module.parent/"__pycache__"/("p03_cache_fixture."+sys.implementation.cache_tag+".pyc")\ncache.parent.mkdir(exist_ok=True)\npy_compile.compile(str(root/"cache_payload.py"),cfile=str(cache),invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH,doraise=True)\n',encoding='utf-8')
probe=ROOT/'cache_policy_probe.py'
OP=ROOT.parents[1]/'p03-worktrees/p03-internal-finance-service/docs/validation/provider-registry-session/preproduction'
probe.write_text('import json,sys\nsys.path.insert(0,'+repr(str(OP))+')\nif "--policy" in sys.argv:\n    import operator_runtime\nimport p03_cache_fixture\nprint(json.dumps({"value":p03_cache_fixture.value,"isolated":sys.flags.isolated,"no_cache_write":sys.dont_write_bytecode,"python":sys.executable}))\n',encoding='utf-8')
python=target/'python.exe'
commands=[[str(python),'-I','-B',str(compiler)],[str(python),'-I','-B',str(probe)],[str(python),'-I','-B',str(probe),'--policy']]
results=[]
for index,command in enumerate(commands):
    if index==2:
        assert marker.is_file()
        marker.rename(ROOT/'cache-positive-control.marker')
    run=subprocess.run(command,capture_output=True,text=True)
    results.append({'command':command,'returncode':run.returncode,'stdout':run.stdout,'stderr':run.stderr,'marker_exists':marker.exists()})
assert results[0]['returncode']==0
assert results[1]['returncode']!=0 and results[1]['marker_exists']
assert results[2]['returncode']==0 and not results[2]['marker_exists']
assert json.loads(results[2]['stdout'])['value']=='SOURCE'
(ROOT/'cache-policy-counterproof.json').write_text(json.dumps({'result':'PASS','scope':'Mutable disposable test SDK only; no qualified artifact writes','runs':results},indent=2),encoding='utf-8')
print(json.dumps({'result':'PASS','unsafe_cache_executed_without_policy':True,'source_loaded_with_policy':True,'qualified_artifacts_modified':False}))
