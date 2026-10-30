"""Offline paired reader/controller acceptance using only newly created fixtures.

Run with an isolated interpreter containing the corrected engine wheel (-I).
No installed config, provider call, target process or financial activation occurs.
"""
import hashlib
import hmac
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).parent/'provider-registry-session'/'preproduction'))
import release
from voice_calibration.core.financial_contracts import FinanceScope, OperationSpec, SlotSpec, TrustedFinanceContext
from voice_calibration.core.financial_ledger import FinancialLedger
from voice_calibration.core.provider_registry import ProviderRegistry, canonical, digest


def must_refuse(action):
    try:
        action()
    except RuntimeError:
        return
    raise AssertionError('Unqualified target was accepted')


with tempfile.TemporaryDirectory(prefix='p03-paired-reader-') as temporary:
    root = Path(temporary)
    source = root/'source'
    (source/'dist').mkdir(parents=True)
    (source/'dist'/'index.js').write_text('export const fixture = true;')
    (source/'package.json').write_text('{"type":"module"}')
    target = release.stage(source, root, 'synthetic-fixture-only')
    control = root/'control'
    control.mkdir()
    registry = ProviderRegistry.initialize(control/'provider-registry', control/'provider-registry.key', 'workspace-a', 'tenant-a')
    config = {'providerRegistryRequired': True, 'image': 'sha256:'+'a'*64,
              'workspaces': [{'workspaceId': 'workspace-a', 'tenantId': 'tenant-a',
                              'engine': {'restoreGuardDir': str(control)}}]}
    release.financial_preflight(root, target, config)
    assert registry.records() == []
    scope = FinanceScope(tenant_id='tenant-a', workspace_id='workspace-a', provider='elevenlabs', account_ref='fixture')
    context = TrustedFinanceContext(scope, 'operator', lambda: True, enabled=True, environment='synthetic')
    spec = OperationSpec(scope=scope, principal='operator', operation_kind='production', idempotency_key='fixture',
                         request_digest=digest('request'), configuration_identity='config', budget_id='fixture',
                         spec_sha256=digest('spec'), quote={}, slots=(SlotSpec(slot='audio', text_sha256=digest('text'), text_length=4),))
    FinancialLedger(registry).admit(spec, authority=context)
    before = registry.records()
    must_refuse(lambda: release.financial_preflight(root, target, config))
    manifest = release.load_release(target)
    claims = {'schema': 'financial-target-v1', 'artifact_sha256': manifest['runtimeHash'],
              'engine_image': config['image'], 'capabilities': ['internal_finance_v1']}
    key = b'k'*32
    (root/'secrets').mkdir()
    (root/'secrets'/'financial-release-authority.key').write_bytes(key)
    (root/'financial-targets').mkdir()
    certificate = root/'financial-targets'/(manifest['runtimeHash']+'.json')
    certificate.write_text(json.dumps({'claims': claims, 'signature': 'forged', 'compatible': True}))
    must_refuse(lambda: release.financial_preflight(root, target, config))
    certificate.write_text(json.dumps({'claims': claims, 'signature': hmac.new(key, canonical(claims).encode(), hashlib.sha256).hexdigest()}))
    release.financial_preflight(root, target, config)
    assert registry.records() == before
    (target/'dist'/'index.js').write_text('export const fixture = false;')
    manifest.update(compiledHash=release.fingerprint(target/'dist'), runtimeHash=release.runtime_fingerprint(target), compatible=True)
    manifest['releaseId'] = 'local-'+manifest['runtimeHash']
    (target/'manifest.json').write_text(json.dumps(manifest))
    must_refuse(lambda: release.financial_preflight(root, target, config))
    assert registry.records() == before
print(json.dumps({'legacy_before_marker': 'PASS', 'missing_qualification': 'PASS',
                  'forged_qualification': 'PASS', 'qualified_exact_target': 'PASS',
                  'rewritten_candidate_manifest': 'PASS', 'provider_calls': 0, 'target_starts': 0}))
