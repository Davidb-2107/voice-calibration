"""Compare restored runs to independently preserved records; never unlock or execute."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys
from restore import hashes, write_record

HERE = Path(__file__).resolve().parent

def classify(current, evidence):
    identity = (current.get('request_digest'), current.get('context', {}).get('configuration_identity'))
    if not all(isinstance(value, str) and value for value in identity):
        return 'missing_identity_keep_blocked'
    if any((row.get('request_digest'), row.get('context', {}).get('configuration_identity')) != identity for row in evidence):
        return 'identity_conflict_keep_blocked'
    independent = [row for row in evidence if row.get('_integrity') == 'provider_registry_verified']
    if independent:
        attempts = [attempt for row in independent for attempt in row['attempts']]
        if not attempts or any(row['status'] == 'execution_unknown' for row in attempts):
            return 'provider_reservation_unknown_keep_blocked'
        return 'provider_responses_preserved_do_not_replay'
    sealed = [row for row in evidence if row.get('_integrity') == 'verified_at_restore']
    consumed = [row for row in sealed if (row.get('approval') or {}).get('consumed_at')]
    if consumed:
        if any(row.get('status') == 'succeeded' and (row.get('result') or {}).get('status') == 'ok' for row in consumed):
            return 'success_record_preserved_do_not_replay'
        return 'approval_claimed_outcome_unknown_keep_blocked'
    if evidence:
        return 'insufficient_independent_proof_keep_blocked'
    return 'no_independent_proof_keep_blocked'

def audit(config):
    data = Path(config['jobQueue']['dataDir']).resolve().parent
    recovery = Path(config['recoveryDir']).resolve()
    if recovery == data or recovery.is_relative_to(data) or data.is_relative_to(recovery):
        raise RuntimeError('Recovery records must be outside restored data')
    archives = []
    issues = []
    for record_path in sorted(recovery.glob('*.json')):
        record = json.loads(record_path.read_text())
        if not isinstance(record, dict) or 'restore_id' not in record or 'previous_data' not in record:
            continue
        source = Path(record['previous_data'])
        expected = data.with_name(data.name + '.before-restore-' + record['restore_id'])
        if source.is_symlink() or source.resolve() != expected or source.parent.resolve() != data.parent:
            issues.append({'record': record_path.name, 'reason': 'invalid_archive_path'})
            continue
        if not source.is_dir():
            issues.append({'record': record_path.name, 'reason': 'archive_missing'})
            continue
        integrity = 'legacy_without_capture_manifest'
        name = record.get('evidence_manifest')
        if name:
            if name != record['restore_id'] + '.evidence.json':
                issues.append({'record': record_path.name, 'reason': 'invalid_manifest_path'})
                continue
            manifest = recovery / name
            try:
                if manifest.is_symlink() or hashlib.sha256(manifest.read_bytes()).hexdigest() != record.get('evidence_sha256'):
                    raise ValueError('manifest changed')
                if hashes(source) != json.loads(manifest.read_text()):
                    raise ValueError('archive changed')
            except (OSError, ValueError, RuntimeError):
                issues.append({'record': record_path.name, 'reason': 'independent_evidence_invalid'})
                continue
            integrity = 'verified_at_restore'
        archives.append((source, integrity, record_path.name))
    runs = []
    for workspace in config['workspaces']:
        workspace_id = workspace['workspaceId']
        relative = (Path(workspace['stateDir']).resolve() / 'gate/workspaces' / workspace_id / 'runs').relative_to(data)
        guard = Path(workspace['engine']['restoreGuardDir']) / 'guard.json'
        fence = json.loads(guard.read_text())
        if fence.get('workspace_id') != workspace_id or fence.get('state') != 'quarantined':
            raise RuntimeError('Reconciliation requires an existing workspace quarantine')
        provider_records = []
        if config.get('providerRegistryRequired') or (guard.parent / 'provider-registry').exists():
            from application.provider_registry import ProviderRegistry, ProviderRegistryBlocked
            try:
                provider_records = ProviderRegistry(guard.parent / 'provider-registry',
                    guard.parent / 'provider-registry.key', workspace_id, workspace['tenantId']).records()
            except (ProviderRegistryBlocked, OSError, ValueError):
                issues.append({'workspace_id': workspace_id, 'reason': 'provider_registry_invalid'})
        for file in sorted((data / relative).glob('*.json')):
            current = json.loads(file.read_text())
            if file.is_symlink() or current.get('workspace_id') != workspace_id or current.get('run_id') != file.stem:
                raise RuntimeError('Invalid workspace run identity')
            evidence = []
            traces = []
            for row in provider_records:
                if row['kind'] == 'run' and row['run_id'] == current['run_id']:
                    attempts = [r for r in provider_records if r['kind'] == 'attempt' and r['run_id'] == row['run_id']]
                    evidence.append({**row, 'context': {'configuration_identity': row['configuration_identity']},
                                     '_integrity': 'provider_registry_verified', 'attempts': attempts})
                    traces.append({'integrity': 'provider_registry_verified', 'attempts': len(attempts),
                                   'statuses': [r['status'] for r in attempts]})
            for source, integrity, record_name in archives:
                proof = source / relative / file.name
                if proof.exists():
                    if proof.is_symlink():
                        issues.append({'record': record_name, 'reason': 'linked_run_evidence'})
                        continue
                    row = json.loads(proof.read_text())
                    if row.get('workspace_id') != workspace_id or row.get('run_id') != current['run_id']:
                        issues.append({'record': record_name, 'reason': 'foreign_run_evidence'})
                        continue
                    evidence.append({**row, '_integrity': integrity})
                    traces.append({'record': record_name, 'integrity': integrity, 'status': row.get('status'),
                                   'approval_claimed': bool((row.get('approval') or {}).get('consumed_at'))})
            runs.append({'workspace_id': workspace_id, 'run_id': current['run_id'], 'restored_status': current['status'],
                'decision': classify(current, evidence), 'execution_allowed': False,
                'restored_record_sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'evidence': traces})
    return {'status': 'BLOCK', 'scope': 'local_restore_reconciliation', 'runs': runs, 'issues': issues,
            'summary': dict(Counter(row['decision'] for row in runs)), 'quarantine': 'unchanged',
            'provider_calls': 0, 'billing_confirmation': 'not_inferred_from_approval_consumption',
            'note': 'Unconsumed or absent records do not prove that no provider call was billed'}

if __name__ == '__main__':
    if len(sys.argv) != 1:
        raise SystemExit('Usage: python preproduction/reconcile.py')
    config = json.loads((HERE / 'config.json').read_text())
    result = audit(config)
    write_record(Path(config['recoveryDir']) / 'reconciliation-report.json', result)
    print(json.dumps({key: value for key, value in result.items() if key != 'runs'}))
