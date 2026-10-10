"""Linux image smoke: real hosted identity, real core, fake paid provider only."""
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import sysconfig
import urllib.request

config = json.loads(sys.stdin.readline())
assert config['supabase']['url'] == f"https://{config['projectRef']}.supabase.co"
assert os.getuid() == 10001
assert not any(k.startswith(('VOICE_', 'ELEVENLABS', 'PYTHONPATH')) for k in os.environ)
import voice_calibration
import silencedetect_trim
import tiktok_spec
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('Credential-bearing redirects refused')
purelib = Path(sysconfig.get_path('purelib')).resolve()
for module in [voice_calibration, silencedetect_trim, tiktok_spec]:
    assert Path(module.__file__).resolve().is_relative_to(purelib)
env = {**os.environ, 'PYTHONPATH': '/opt/fixtures'}

def check(label, command, cwd='/data'):
    result = subprocess.run(command, cwd=cwd, env=os.environ, capture_output=True, text=True, timeout=120)
    if result.returncode:
        # No credentials are passed to these offline tests.
        print(json.dumps({'stage':label,'exit':result.returncode,'diagnostic':(result.stdout+result.stderr)[-7000:]}),flush=True)
        raise RuntimeError(label+' failed')
    print(json.dumps({'stage':label,'status':'PASS','tail':result.stdout[-450:]}),flush=True)

check('python-installed-tests', [sys.executable,'-I','-m','pytest','--import-mode=importlib',
      '-o','cache_dir=/tmp/pytest-cache',
      '/opt/vault/Shared/voice-calibration/test_installed_workspace_onboarding.py','-q','--tb=short'])
check('node-tests', ['npm','test'], '/opt/node')
from voice_calibration.onboarding import create_profile, select_voice, validate_ready
from voice_calibration.voice_profile import calibration_context, resolve_project_voice, VoiceProfileError
run_root = Path('/data/run')
run_root.mkdir()
reference = 'elevenlabs:HOSTEDTESTVOICE000001:fr:hosted-v1'
for account in config['accounts']:
    corpus = run_root/account['suffix']/'corpus/voice_wpm.json'
    corpus.parent.mkdir(parents=True)
    corpus.write_text('{}')
    context = calibration_context(corpus)
    create_profile({'voice_id':'HOSTEDTESTVOICE000001','model_id':'eleven_multilingual_v2',
        'voice_settings':{'stability':0.65,'similarity_boost':0.75,'style':0.0,'use_speaker_boost':True,'speed':1.0},
        'corpus':{'alias':'HostedIsolationVoice','language':'fr'},'atempo':1.0},reference,context=context)
    account['voiceConfig'] = resolve_project_voice(select_voice(reference,context=context),context=context)
    try:
        validate_ready(select_voice(reference,context=context),context=context)
    except VoiceProfileError as error:
        assert 'CUT' in str(error)
    else:
        raise RuntimeError('Empty CUT corpus passed')
    request = urllib.request.Request(config['supabase']['url']+'/auth/v1/token?grant_type=password',
        data=json.dumps({'email':account['email'],'password':account.pop('password')}).encode(),
        headers={'Content-Type':'application/json','apikey':config['supabase']['publishableKey']})
    with urllib.request.build_opener(NoRedirect).open(request,timeout=30) as response:
        session=json.load(response)
    assert session['user']['id']==account['userId']
    account['accessToken']=session['access_token']
config.update({'python':sys.executable,'worker':'/opt/fixtures/hosted_worker.py',
               'pythonSource':'/opt/fixtures','runRoot':str(run_root)})
child=subprocess.Popen(['node','/opt/node/test/hosted-supabase-validation.mjs'],cwd='/opt/node',env=env,
    stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
child.stdin.write(json.dumps(config));child.stdin.close()
report=None
try:
    for line in child.stdout:
        message=json.loads(line)
        if message.get('phase')=='ready_for_revocation':
            print(json.dumps(message),flush=True)
            assert sys.stdin.readline().strip()=='revoked'
            (run_root/'membership-revoked').write_text('revoked')
        elif message.get('status')=='PASS':
            report=message
    assert child.wait(timeout=30)==0, 'Protected API test failed (diagnostics suppressed to protect sessions)'
finally:
    if child.poll() is None:
        child.terminate();child.wait(timeout=15)
assert report is not None
for account in config['accounts']:
    context=calibration_context(run_root/account['suffix']/'corpus/voice_wpm.json')
    validate_ready(select_voice(reference,context=context),context=context)
versions={item.metadata['Name']:item.version for item in importlib.metadata.distributions()}
report.update({'private_cut_preflight':{'before':'BLOCK','after_simulated_publication':'PASS'},
 'platform':sys.platform,'uid':os.getuid(),'installedCore':str(Path(voice_calibration.__file__).resolve()),
 'python':sys.version.split()[0],'node':subprocess.check_output(['node','--version'],text=True).strip(),
 'ffmpeg':subprocess.check_output(['ffmpeg','-version'],text=True).splitlines()[0],
 'ffprobe':subprocess.check_output(['ffprobe','-version'],text=True).splitlines()[0],'pythonPackages':versions})
print(json.dumps(report),flush=True)
