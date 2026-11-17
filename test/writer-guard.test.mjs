import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriterGuard } from '../src/writer-guard.mjs';

const nativeId = '01a1e000-1234-7234-8234-123456789abc';
function input(home) {
  return {
    projection: { thread: { activeProviderThreadId: 'provider-thread-1' }, providerThreads: [
      { id: 'provider-thread-1', nativeThreadRef: { nativeId } },
    ] },
    provider: { continuation: { groupKey: `codex:home:${home}` } },
  };
}

test('probes an actual OS writer lock, waits while held, and leaves all files unchanged', async () => {
  const home = await mkdtemp(join(tmpdir(), 't3-writer-guard-'));
  const dir = join(home, 'thread-writer-locks');
  const path = join(dir, `${nativeId}.lock`);
  const guard = new WriterGuard();
  let holder;
  try {
    await mkdir(dir);
    await writeFile(join(dir, '.coordination.lock'), 'coordination');
    await writeFile(path, 'writer');
    const { projection, provider } = input(home);
    assert.equal((await guard.probe(projection, provider)).status, 'free');
    holder = spawn(guard.pythonCommand, ['-c',
      'import fcntl,sys; f=open(sys.argv[1],"rb"); fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); sys.stdin.read()', path],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    await Promise.race([
      once(holder.stdout, 'data'),
      once(holder, 'error').then(([error]) => { throw error; }),
    ]);
    assert.equal((await guard.probe(projection, provider)).status, 'held');
    const exited = once(holder, 'exit'); holder.stdin.end(); await exited;
    assert.equal((await guard.probe(projection, provider)).status, 'free');
    assert.equal(await readFile(path, 'utf8'), 'writer');
    assert.equal(await readFile(join(dir, '.coordination.lock'), 'utf8'), 'coordination');
    assert.deepEqual((await readdir(dir)).sort(), ['.coordination.lock', `${nativeId}.lock`].sort());
    await rm(path);
    assert.equal((await guard.probe(projection, provider)).status, 'free');
    assert.deepEqual(await readdir(dir), ['.coordination.lock']);
  } finally {
    holder?.kill(); await rm(home, { recursive: true, force: true });
  }
});

test('unknown or uninspectable locks fail closed', async () => {
  const guard = new WriterGuard();
  assert.equal((await guard.probe({ thread: {}, providerThreads: [] }, {})).status, 'unknown');
  const { projection, provider } = input('/nonexistent/t3-writer-test-home');
  assert.equal((await guard.probe(projection, provider)).status, 'unknown');
  const bad = input('/tmp'); bad.projection.providerThreads[0].nativeThreadRef.nativeId = '../../other';
  assert.equal((await guard.probe(bad.projection, bad.provider)).status, 'unknown');
});
