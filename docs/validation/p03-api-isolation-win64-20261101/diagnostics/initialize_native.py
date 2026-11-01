import json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent
p=json.loads((ROOT/'prepared.json').read_text())
control=Path(p['control'])
assert Path(sys.executable).resolve()==Path(p['python']).resolve()
assert sys.version_info[:3]==(3,12,10) and sys.flags.isolated and sys.dont_write_bytecode
sys.path.insert(0,str(control))
import release
Registry,required,_=release._financial_reader()
module=Path(sys.modules[Registry.__module__].__file__).resolve()
assert module.is_relative_to(Path(p['root'])/'authority/runtime'),str(module)
directory=control/'recovery/workspace-api'
registry=Registry.initialize(directory/'provider-registry',directory/'provider-registry.key','workspace-api','tenant-qualification')
assert not required(registry)
(directory/'guard.json').write_text(json.dumps({'version':1,'workspace_id':'workspace-api','state':'ready'}),encoding='utf-8')
import financial_preflight
verdict=financial_preflight.verify_config(control)
print(json.dumps({'python':sys.executable,'version':list(sys.version_info[:3]),'reader':str(module),'verdict':verdict,'isolated':sys.flags.isolated,'dont_write_bytecode':sys.dont_write_bytecode,'sys_path':sys.path}))
