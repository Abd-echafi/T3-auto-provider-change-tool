import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const probeScript = fileURLToPath(new URL('../scripts/probe-writer-lock.py', import.meta.url));

export class WriterGuard {
  constructor(pythonCommand = process.platform === 'darwin' ? '/usr/bin/python3' : 'python3') {
    this.pythonCommand = pythonCommand;
  }

  async probe(projection, provider) {
    const thread = projection.providerThreads?.find(t => t.id === projection.thread.activeProviderThreadId);
    const nativeId = thread?.nativeThreadRef?.nativeId;
    const group = provider.continuation?.groupKey;
    const home = provider.runtimePaths?.homePath ??
      (group?.startsWith('codex:home:') ? group.slice('codex:home:'.length) : null);
    if (!home || !isAbsolute(home) || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(nativeId ?? '')) {
      return { status: 'unknown', reason: 'native conversation or shared home could not be identified' };
    }
    try {
      const { stdout } = await execute(this.pythonCommand, [probeScript, home, nativeId], {
        timeout: 5000, maxBuffer: 4000,
      });
      const result = JSON.parse(stdout);
      if (!['held', 'free', 'unknown'].includes(result.status)) throw new Error('Unsupported probe output.');
      return result;
    } catch {
      return { status: 'unknown', reason: 'writer lock probe failed; check the configured Python runtime' };
    }
  }
}
