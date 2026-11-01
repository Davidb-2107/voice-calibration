/** Invoke only the independent operator reader; never trust a candidate capability claim. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';

const exec = promisify(execFile);

export function createFinancialPreflight(config, controlRoot, expectedConfigHash) {
  const interpreter = config.registryPython;
  if (typeof interpreter !== 'string' || !isAbsolute(interpreter))
    throw new Error('Explicit trusted control interpreter required');
  const root = resolve(controlRoot);
  const interpreterPath = process.platform === 'win32' ? resolve(interpreter).toLowerCase() : resolve(interpreter);
  const configBytes = readFileSync(join(root, 'config.json'));
  const configHash = createHash('sha256').update(configBytes).digest('hex');
  if (!isDeepStrictEqual(JSON.parse(configBytes.toString('utf8')), config)
      || (expectedConfigHash !== undefined && expectedConfigHash !== configHash))
    throw new Error('Operator configuration changed since composition');
  const image = config.image;
  const releaseId = config.commit;
  const registered = config.workspaces.map(workspace => workspace.workspaceId);
  return async (workspaceId) => {
    if (workspaceId !== undefined && !registered.includes(workspaceId))
      throw new Error('Workspace is not registered in operator control');
    const expected = workspaceId === undefined ? registered : [workspaceId];
    const args = ['-I', '-B', join(root, 'financial_preflight.py'), '--expected-config-sha256', configHash,
      ...(workspaceId === undefined ? [] : ['--workspace', workspaceId])];
    const { stdout } = await exec(interpreter, args,
      { cwd: root, timeout: 10000, maxBuffer: 65536, windowsHide: true });
    const verdict = JSON.parse(stdout);
    const actualInterpreter = typeof verdict?.operatorPython === 'string'
      ? (process.platform === 'win32' ? resolve(verdict.operatorPython).toLowerCase() : resolve(verdict.operatorPython)) : null;
    if (verdict?.schema !== 'financial-preflight-v1' || verdict.engineImage !== image
        || actualInterpreter !== interpreterPath
        || !Array.isArray(verdict.operatorVersion) || verdict.operatorVersion[0] !== 3 || verdict.operatorVersion[1] !== 12
        || verdict.configSha256 !== configHash
        || `local-${verdict.artifactSha256}` !== releaseId
        || !Array.isArray(verdict.workspaceIds) || verdict.workspaceIds.length !== expected.length
        || expected.some((id, index) => verdict.workspaceIds[index] !== id))
      throw new Error('Independent financial preflight returned a mismatched target or scope');
  };
}
