"""Test-only receipt-producing provider. No network or real TTS credentials."""
import json
import os
import time
from pathlib import Path
from test_core_calibration import FakeDeps
from voice_calibration.core.calibration import run_calibration
from voice_calibration.core.contracts import CalibrationRequest
from voice_calibration.mcp_server import server

def simulated_runner(payload, *, context):
    assert context.secrets.get('ELEVENLABS_API_KEY').startswith('hosted-test-fake-')
    request = CalibrationRequest.model_validate(payload)
    deps = FakeDeps(durations=[40.0] * 25)
    original = deps.synthesize
    state = Path(os.environ['VOICE_CALIBRATION_STATE_DIR'])
    def synthesize(*args, **kwargs):
        value = original(*args, **kwargs)
        with (state / 'provider-receipts.jsonl').open('a', encoding='utf-8') as receipts:
            receipts.write(json.dumps({'simulated': True, 'call': len(deps.synthesize_calls)}) + '\n')
            receipts.flush()
            os.fsync(receipts.fileno())
        deadline = time.monotonic() + 180
        while (state / 'chaos-hold').exists():
            if time.monotonic() > deadline:
                raise RuntimeError('Simulation hold expired')
            time.sleep(0.05)
        return value
    deps.synthesize = synthesize
    return run_calibration(request, deps=deps.as_calibration_deps(),
                           persist_results=False, context=context).model_dump(mode='json')

if __name__ == '__main__':
    server._run_payload = simulated_runner
    server.main()
