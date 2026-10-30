/** Invoke only the independent operator reader; never trust a candidate capability claim. */
import { execFile } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function createFinancialPreflight(config, controlRoot) {
  const interpreter = config.registryPython;
  if (typeof interpreter !== 'string' || !isAbsolute(interpreter))
    throw new Error('Explicit trusted control interpreter required');
  const root = resolve(controlRoot);
  const image = config.image;
  const releaseId = config.commit;
  const registered = config.workspaces.map(workspace => workspace.workspaceId);
  return async (workspaceId) => {
    if (workspaceId !== undefined && !registered.includes(workspaceId))
      throw new Error('Workspace is not registered in operator control');
    const expected = workspaceId === undefined ? registered : [workspaceId];
    const args = ['-I', '-B', join(root, 'financial_preflight.py'),
      ...(workspaceId === undefined ? [] : ['--workspace', workspaceId])];
    const { stdout } = await exec(interpreter, args,
      { cwd: root, timeout: 10000, maxBuffer: 65536, windowsHide: true });
    const verdict = JSON.parse(stdout);
    if (verdict?.schema !== 'financial-preflight-v1' || verdict.engineImage !== image
        || `local-${verdict.artifactSha256}` !== releaseId
        || !Array.isArray(verdict.workspaceIds) || verdict.workspaceIds.length !== expected.length
        || expected.some((id, index) => verdict.workspaceIds[index] !== id))
      throw new Error('Independent financial preflight returned a mismatched target or scope');
  };
}
