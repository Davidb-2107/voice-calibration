import json,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent
p=json.loads((ROOT/'prepared.json').read_text())
case=sys.argv[1]
trace=ROOT/('broker-docker-'+case+'.json')
wrapper=ROOT/('broker-lifecycle-'+case+'.mjs')
source=ROOT.parents[1]/'p03-worktrees/p03-internal-finance-service/docs/validation/provider-registry-session/preproduction/api_broker.mjs'
wrapper.write_text('''import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
const trace=TRACE;
const commands=[];
const original=promisify(cp.execFile);
const replacement=()=>{throw new Error('Use promisified execFile');};
replacement[promisify.custom]=async (file,args,options)=>{
  if(file!=='docker')return original(file,args,options);
  commands.push(args);writeFileSync(trace,JSON.stringify(commands));
  return {stdout:'[]',stderr:''};
};
cp.execFile=replacement;syncBuiltinESMExports();
const input=new PassThrough();Object.defineProperty(process,'stdin',{value:input});
const config=CONFIG;
process.argv=[process.execPath,SOURCE,config,createHash('sha256').update(readFileSync(config)).digest('hex'),String(process.pid)];
await import(pathToFileURL(SOURCE).href);
input.write(JSON.stringify({kind:'event',name:'stopped',value:{}})+'\\n');
'''.replace('TRACE',json.dumps(str(trace))).replace('CONFIG',json.dumps(str(Path(p['control'])/'config.json'))).replace('SOURCE',json.dumps(str(source))),encoding='utf-8')
run=subprocess.run([p['node'],str(wrapper)],capture_output=True,text=True,timeout=50)
commands=json.loads(trace.read_text()) if trace.exists() else []
result={'case':case,'returncode':run.returncode,'stdout':run.stdout,'stderr':run.stderr,'docker_commands_mocked':commands,
    'real_docker_commands':False,'no_unused_engine_removal':not any(args[0]=='rm' for args in commands)}
(ROOT/('broker-lifecycle-'+case+'.json')).write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(result))
assert run.returncode==0
assert result['no_unused_engine_removal'],'An unused registered transport must not invoke container removal'
