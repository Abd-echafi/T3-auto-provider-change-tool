import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { T3Client } from '../src/t3-client.mjs';
import { blockedRun } from '../src/policy.mjs';

async function fixture(idleCompaction, recordRun = 'run-1') {
  const home = await mkdtemp(join(tmpdir(), 't3-message-meta-'));
  await mkdir(join(home, 'userdata'));
  const client = new T3Client({ t3Home: home });
  const seed = `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE orchestration_v2_projection_messages (thread_id TEXT, run_id TEXT, message_id TEXT, payload_json TEXT)')
c.execute('INSERT INTO orchestration_v2_projection_messages VALUES (?,?,?,?)', ('thread-1',sys.argv[3],'message-1',sys.argv[2]))
c.commit()
c.close()`;
  await promisify(execFile)(client.pythonCommand, ['-c', seed, join(home, 'userdata/statev2.sqlite'),
    JSON.stringify({ id: 'message-1', role: 'user', text: 'PRIVATE PROMPT MUST NOT BE RETURNED', idleCompaction }), recordRun]);
  const thread = { id: 'thread-1', providerInstanceId: 'a', modelSelection: { instanceId: 'a', model: 'gpt-model' } };
  const projection = { thread, runs: [{ id: 'run-1', status: 'failed', providerInstanceId: 'a', ordinal: 1,
    userMessageId: 'message-1', rootNodeId: 'root', completedAt: '2026-11-19T20:00:00Z' }],
    messages: [], providerThreads: [], runtimeRequests: [], turnItems: [{ id: 'error-1', type: 'error',
      status: 'failed', runId: 'run-1', nodeId: 'root', ordinal: 1, updatedAt: '2026-11-19T20:00:00Z',
      failure: { class: 'usage_limit' } }] };
  client.requiredRead = async () => structuredClone(projection);
  return { client, projection, shell: { ...thread, latestRunId: 'run-1' },
    close: () => rm(home, { recursive: true, force: true }) };
}

test('bounded projection recovers source metadata without returning prompt text', async () => {
  const f = await fixture(null);
  try {
    const projection = await f.client.getProjection('thread-1');
    assert.deepEqual(projection.messages, [{ id: 'message-1', role: 'user', idleCompaction: null }]);
    assert.equal(blockedRun(projection, f.shell)?.run.id, 'run-1');
    assert.ok(!JSON.stringify(projection).includes('PRIVATE PROMPT'));
  } finally { await f.close(); }
});

test('omitted idle-compaction metadata is recovered and still blocks maintenance recovery', async () => {
  const f = await fixture('beforeCacheExpires');
  try {
    const projection = await f.client.getProjection('thread-1');
    assert.equal(projection.messages[0].idleCompaction, 'beforeCacheExpires');
    assert.equal(blockedRun(projection, f.shell), null);
  } finally { await f.close(); }
});

test('wrong run or unavailable metadata cannot authorize recovery', async () => {
  const f = await fixture(null, 'different-run');
  try {
    assert.equal(blockedRun(await f.client.getProjection('thread-1'), f.shell), null);
    await rm(join(f.client.home, 'userdata/statev2.sqlite'));
    assert.equal(blockedRun(await f.client.getProjection('thread-1'), f.shell), null);
  } finally { await f.close(); }
});
