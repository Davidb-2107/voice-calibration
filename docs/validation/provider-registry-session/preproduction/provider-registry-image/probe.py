"""Offline container probe: lost response, restored approval, isolated evidence."""
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, '/opt/test-fixtures')
from chaos_worker import simulated_runner
from voice_calibration.mcp_server import server
from voice_calibration.core.authorization import TenantWorkspace, TenantWorkspaceAuthorizer, principal_scope

workspace, tenant = os.environ['VOICE_CALIBRATION_WORKSPACE_ID'], os.environ['VOICE_CALIBRATION_TENANT_ID']
server.set_workspace_authorizer(TenantWorkspaceAuthorizer({'gateway': TenantWorkspace(tenant, workspace)}))
state = Path(os.environ['VOICE_CALIBRATION_STATE_DIR'])
mode = sys.argv[1]
with principal_scope('gateway'):
    server._configure_instance()
    if mode == 'crash':
        def runner(payload, *, context):
            if payload['dry_run']:
                return simulated_runner(payload, context=context)
            from test_core_calibration import FakeDeps
            from voice_calibration.core.calibration import run_calibration
            from voice_calibration.core.contracts import CalibrationRequest
            deps = FakeDeps(durations=[40.0] * 5)
            def lost_response(*args, **kwargs):
                (state / 'simulated-call').write_text('one provider invocation, response lost')
                os._exit(73)
            deps.synthesize = lost_response
            return run_calibration(CalibrationRequest.model_validate(payload), deps.as_calibration_deps(),
                                   context=context, persist_results=False).model_dump(mode='json')
        server._run_payload = runner
    else:
        server._run_payload = simulated_runner
    gate = server._get_gate(workspace)
    if mode in {'first', 'crash'}:
        request = {'voice': 'Probe', 'voice_id': 'simulated-voice', 'model_id': 'eleven_multilingual_v2',
                   'voice_settings': {'stability': .65, 'similarity_boost': .75, 'style': 0, 'use_speaker_boost': True},
                   'mode': 'precision', 'language': 'fr', 'runs': 3,
                   'text_source': {'kind': 'inline', 'text': 'Bonjour ceci est une narration simulée.'}, 'postproc': 'cut'}
        proposal = gate.propose(workspace, request)
        gate.approve(workspace, proposal.run_id, proposal.request_digest)
        file = state / 'gate/workspaces' / workspace / 'runs' / (proposal.run_id + '.json')
        (state / 'approved-snapshot.json').write_bytes(file.read_bytes())
        (state / 'probe-run').write_text(proposal.run_id)
        result = gate.execute(workspace, proposal.run_id)
        assert result.status == 'succeeded'
    else:
        run_id = (state / 'probe-run').read_text()
        if mode == 'recover':
            assert gate.get(workspace, run_id).status == 'execution_unknown'
        file = state / 'gate/workspaces' / workspace / 'runs' / (run_id + '.json')
        file.write_bytes((state / 'approved-snapshot.json').read_bytes())
        assert gate.execute(workspace, run_id).status == 'execution_unknown'
    records = server._instance_context.provider_registry.records()
    attempts = [row for row in records if row['kind'] == 'attempt']
    expected = 1 if mode == 'recover' else 3
    assert len(attempts) == expected
    assert all(row['workspace_id'] == workspace and row['tenant_id'] == tenant for row in records)
    assert all(row['status'] == ('execution_unknown' if mode == 'recover' else 'received') for row in attempts)
    key = Path(os.environ['VOICE_CALIBRATION_PROVIDER_REGISTRY_KEY'])
    try:
        with key.open('ab'):
            pass
    except OSError:
        pass
    else:
        raise AssertionError('Signing key unexpectedly writable')
    assert not Path('/workspace/../other-workspace').exists()
    print(json.dumps({'status': 'PASS', 'workspace': workspace, 'mode': mode,
                      'attempts': len(attempts), 'provider': 'simulated', 'real_provider_calls': 0}))
