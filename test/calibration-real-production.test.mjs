import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createCalibrationApplication } from '../dist/calibration/application.js';
import { createCalibrationBridge,NodeMcpStdioTransport } from '../dist/calibration/bridge.js';
import { startCalibrationUi } from '../dist/calibration/http-server.js';
import { createSupabaseWorkspaceResolver } from '../dist/calibration/supabase-auth.js';

const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const member='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');

test('real-mode consent, signed production receipt and 1/0 via launcher HTTP MCP, fake provider only',{
  skip:!process.env.VOICE_CALIBRATION_TEST_PYTHON || !process.env.VOICE_CALIBRATION_TEST_MCP_ROOT,
  timeout:300000,
},async t=>{
  const root=mkdtempSync(join(tmpdir(),'real-v2-fixture-'));
  const engine=process.env.VOICE_CALIBRATION_TEST_MCP_ROOT;
  const vault=resolve(engine,'../..');
  const transport=new NodeMcpStdioTransport(process.env.VOICE_CALIBRATION_TEST_PYTHON,
    ['-B',join(engine,'tests/reusable_engine_fixture.py'),root,'real-production']);
  t.after(async()=>{await transport.close();rmSync(root,{recursive:true,force:true});});
  await transport.schema('inert-test-secret',20000);
  const fixture=JSON.parse(readFileSync(join(root,'fixture-ready.json')));
  const bridge=createCalibrationBridge({providerMode:'elevenlabs',transport,
    credentials:{forRun:async()=>({provider:'elevenlabs',secret:'inert-test-secret'})}});
  const application=createCalibrationApplication({providerMode:'elevenlabs',bridge,canonical:{},
    repositories:{runs:{list:async()=>[],recoverRunning:async()=>{}}}});
  const auth={url:'https://fixture.supabase.co',publishableKey:'sb_publishable_fixture',fetch:async(url,options)=>{
    const uid=options.headers.authorization==='Bearer owner-token'?owner:
      options.headers.authorization==='Bearer member-token'?member:null;
    if(!uid)return new Response('{}',{status:401});
    return Response.json(String(url).includes('/auth/v1/user')?{id:uid,role:'authenticated',email_confirmed_at:'2026-10-28T00:00:00Z'}:
      [{id:fixture.scope.workspaceId,tenant_id:fixture.scope.tenantId}]);
  }};
  const api=await startCalibrationUi({resolveApplication:createSupabaseWorkspaceResolver(auth,
    [{tenantId:fixture.scope.tenantId,workspaceId:fixture.scope.workspaceId,application}]),
    closeApplications:async()=>application.close()});
  t.after(()=>api.close());
  const post=(path,body,token='owner-token')=>fetch(api.url+'/api/v1'+path,{method:'POST',
    headers:{authorization:'Bearer '+token,'content-type':'application/json','x-calibration-nonce':application.getSessionNonce()},body:JSON.stringify(body)});
  const launch=args=>new Promise((done,reject)=>{
    const child=spawn(process.env.VOICE_CALIBRATION_TEST_PYTHON,
      ['-B',join(engine,'tests/reusable_launcher_fixture.py'),api.url,'--vault-root',vault,...args],
      {windowsHide:true,timeout:60000,env:{...process.env,VOICE_CALIBRATION_TEST_AUTHORITY:join(root,'TEST-authority')}});
    let stdout='',stderr='';child.stdout.on('data',d=>{stdout+=d;});child.stderr.on('data',d=>{stderr+=d;});
    child.on('error',reject);child.on('close',code=>done({code,stdout,stderr}));
  });
  const ok=result=>{assert.equal(result.code,0,result.stderr+result.stdout);return result;};
  const parsed=result=>JSON.parse(ok(result).stdout.trim().split('\n').at(-1));
  assert.equal((await post(`/calibration-runs/${fixture.runId}/reuse-publication`,{})).status,200);
  const projects=['Real Mode A','Real Mode B'].map(n=>join(root,'projects',n));
  const gates=[];
  for(const project of projects){
    ok(await launch(['create','--name',project.split(/[\\/]/).at(-1),'--root',join(root,'projects'),
      '--project-type','preparation_fixture','--slug','pilot','--voice-profile',fixture.profileId]));
    gates.push(hash(join(project,'_gate/gate_2_3.py')));
    writeFileSync(join(project,'outputs/01-pilot/narration.txt'),'mot '.repeat(240).trim());
  }
  const episodes=projects.map(p=>join(p,'outputs/01-pilot'));
  const bindings=projects.map(p=>JSON.parse(readFileSync(join(p,'_project/calibration-connection.json'))).preparation);
  const corpora=bindings.map(b=>join(root,'state/prepared-projects',b.datasetId,'voice_wpm.json'));
  const produce=(index,action,run,extra=[])=>launch(['produce','--episode',episodes[index],'--action',action,
    ...(run?['--run-id',run.runId,'--digest',run.requestDigest]:[]),...extra]);
  const counters=()=>JSON.parse(readFileSync(join(root,'real-mode-counters.json')));
  const run=parsed(await produce(0,'propose'));
  assert.equal(counters().fakeProviderCalls,0);
  assert.equal((await produce(0,'execute',run)).code,1);
  assert.equal((await produce(0,'approve',run)).code,1);
  assert.equal(counters().fakeProviderCalls,0);
  parsed(await produce(0,'approve',run,['--agreement','real']));
  const result=parsed(await produce(0,'execute',run));
  assert.equal(result.status,'succeeded');
  assert.equal(result.production.synthetic,false);
  assert.equal(result.production.observedRuns,1);
  assert.equal(result.production.productionReceipt.claims.schema,'project-production-v2');
  assert.equal(hash(join(episodes[0],'audio/narration.mp3')),result.production.audioSha256);
  const admitted=hash(corpora[0]);
  assert.equal(parsed(await produce(0,'execute',run)).production.audioSha256,result.production.audioSha256);
  assert.equal(hash(corpora[0]),admitted);
  assert.deepEqual(JSON.parse(readFileSync(corpora[1])),{});
  const pending=JSON.parse(readFileSync(join(episodes[0],'audio/real-production.json')));
  const body={action:'execute',...pending.request,runId:run.runId,requestDigest:run.requestDigest};
  assert.equal((await post('/projects/production',body,'member-token')).status,409);
  assert.equal((await post('/projects/production',{...body,maxCalls:999})).status,400);
  const original=bridge.prepareProject;
  try{
    for(const fault of ['audio','text','binding','profile','consent','cost']){
      bridge.prepareProject=async()=>{
        const value=structuredClone(result);
        const metadata=JSON.parse(readFileSync(join(episodes[0],'audio.json')));
        value.production={...metadata,audioBase64:readFileSync(join(episodes[0],'audio/narration.mp3')).toString('base64')};
        // Use the exact transport shape, before the launcher's local audio metadata additions.
        for(const k of ['voice_profile','variant','postproc','voice_id','model_id','voice_settings','atempo','duration_s','duration_raw_s','narration_sha1','audio_sha256'])delete value.production[k];
        if(fault==='audio')value.production.audioSha256='0'.repeat(64);
        else if(fault==='text')value.production.productionReceipt.claims.narrationSha256='0'.repeat(64);
        else if(fault==='binding')value.production.productionReceipt.claims.binding=bindings[1];
        else if(fault==='profile')value.production.productionReceipt.claims.profile.configuration.voice_id='foreign';
        else if(fault==='cost')value.production.productionReceipt.claims.chargedCredits=999999;
        else value.production.productionReceipt.claims.consent.runId='00000000-0000-0000-0000-000000000000';
        return value;
      };
      assert.equal((await post('/projects/production',body)).status,409,fault);
    }
  }finally{bridge.prepareProject=original;}
  assert.equal(counters().fakeProviderCalls,1);
  assert.equal(counters().realProviderAttempts,0);
  assert.equal(counters().withoutConsent,0);
  assert.equal(hash(fixture.corpus),fixture.sha256);
  for(let i=0;i<projects.length;i++)assert.equal(hash(join(projects[i],'_gate/gate_2_3.py')),gates[i]);
  t.diagnostic(JSON.stringify({realProviderCalls:0,fakeProviderCalls:1,observations:[1,0],replayAdded:0,
    authenticatedHttpMcp:true,launcherExplicitConsent:true,originalProjectGatesPreserved:true}));
});
