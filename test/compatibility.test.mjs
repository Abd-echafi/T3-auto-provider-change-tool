import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { T3Client } from '../src/t3-client.mjs';
import { CompatibilityError, validateProjection } from '../src/compatibility.mjs';

async function fakeT3(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 't3-capabilities-'));
  const selection = { instanceId: 'account-1', model: 'gpt-model', options: [
    { id: 'reasoningEffort', value: 'high' },
  ] };
  const thread = { id: 'existing-work', providerInstanceId: 'account-1', modelSelection: selection,
    status: 'completed', latestRunId: 'run-1', activeRunId: null, futureField: { arbitrary: true } };
  const config = { providers: [{ instanceId: 'account-1', driver: 'codex', enabled: true,
    installed: true, status: 'ready', auth: { status: 'authenticated' },
    models: [{ slug: 'gpt-model', capabilities: { optionDescriptors: [
      { id: 'reasoningEffort', type: 'select', options: [{ id: 'high' }] },
    ] } }], usageLimits: { checkedAt: new Date().toISOString(), windows: [{ usedPercent: 20 }] },
  }], futureField: { arbitrary: true } };
  const shell = { threads: [thread], futureField: true };
  const projection = { thread: structuredClone(thread), runs: [{ id: 'run-1', ordinal: 1, providerInstanceId: 'account-1',
    userMessageId: 'message-1', status: 'completed' }], messages: [], turnItems: [], runtimeRequests: [],
    providerThreads: [], futureField: ['ignored'] };
  options.change?.({ config, shell, projection });
  const calls = [];
  const http = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/auth/websocket-ticket/rpc') return response.end(JSON.stringify({ ticket: 'fixture-ticket' }));
    if (request.url === '/api/orchestration/shell') {
      response.statusCode = options.shellStatus ?? 200;
      return response.end(JSON.stringify(shell));
    }
    response.statusCode = 404;
    response.end('{}');
  });
  const ws = new WebSocketServer({ server: http, path: '/ws' });
  ws.on('connection', socket => socket.on('message', bytes => {
    const request = JSON.parse(bytes.toString());
    if (request._tag !== 'Request') return;
    calls.push(request);
    let value, error;
    if (request.tag === options.missingMethod) error = 'UnknownRpcMethod';
    else if (request.tag === 'server.getConfig') value = config;
    else if (request.tag === 'server.refreshProviders') value = { providers: config.providers };
    else if (request.tag === 'orchestration.getThreadProjection') value = projection;
    else if (request.tag === 'orchestration.dispatchCommand') {
      if (options.acceptInvalidTarget) value = { sequence: 1 };
      else error = 'OrchestrationV2DispatchCommandError';
    } else if (request.tag === 'orchestration.forceStopThread') error = 'OrchestrationV2ForceStopThreadError';
    else error = 'UnknownRpcMethod';
    socket.send(JSON.stringify({ _tag: 'Exit', requestId: request.id,
      exit: error ? { _tag: 'Failure', cause: { _tag: 'Fail', error: { _tag: error } } } : { _tag: 'Success', value } }));
  }));
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const runtime = { origin: `http://127.0.0.1:${http.address().port}`, pid: 123,
    startedAt: '2026-01-01T00:00:00Z', serverVersion: options.version ?? '90.91.92-future' };
  const runtimeFile = join(directory, 'userdata/server-runtime.json');
  await mkdir(join(directory, 'userdata'));
  await writeFile(runtimeFile, JSON.stringify(runtime));
  const cli = join(directory, 'fixture-cli.mjs');
  await writeFile(cli, `#!/usr/bin/env node
if (process.argv.includes('issue')) console.log(JSON.stringify({sessionId:'fixture-session',token:'local-fixture-token',expiresAt:new Date(Date.now()+3600000).toISOString()}));
else console.log('revoked');
`, { mode: 0o700 });
  return { calls, config, shell, projection, runtime, runtimeFile,
    client: () => new T3Client({ t3Home: directory, t3Command: cli, writable: options.writable !== false }),
    async close() {
      for (const socket of ws.clients) socket.terminate();
      await Promise.all([new Promise(resolve => ws.close(resolve)), new Promise(resolve => http.close(resolve))]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('unseen stable, major, and nightly versions pass the real transport handshake when capabilities match', async () => {
  for (const version of ['0.1.11', '12.0.0', '999.1.2-nightly.20990101']) {
    const server = await fakeT3({ version });
    const client = server.client();
    try {
      await client.connect();
      assert.equal(client.connected, true);
      assert.equal(client.compatibility.ready, true);
      assert.equal(client.compatibility.serverVersion, version);
      assert.equal(client.compatibility.protocol, '2');
      const mutations = server.calls.filter(c => ['orchestration.dispatchCommand', 'orchestration.forceStopThread'].includes(c.tag));
      assert.equal(mutations.length, 2);
      assert.ok(mutations.every(c => c.payload.threadId.startsWith('failover-capability:')));
      assert.ok(mutations.every(c => c.payload.threadId !== 'existing-work'));
      assert.ok(await client.runtimeUnchanged());
    } finally { await client.close(); await server.close(); }
  }
});

test('read-only clients inspect capabilities without issuing command probes', async () => {
  const server = await fakeT3({ writable: false });
  const client = server.client();
  try {
    await client.connect();
    assert.equal(client.compatibility.writable, false);
    assert.deepEqual(server.calls.map(c => c.tag).sort(), ['orchestration.getThreadProjection', 'server.getConfig'].sort());
    await assert.rejects(client.releaseWriter('existing-work', 'run-1'), /read-only/);
    await assert.rejects(client.dispatch({}), /read-only/);
  } finally { await client.close(); await server.close(); }
});

test('both legacy option dictionaries and extra response fields remain compatible', async () => {
  const server = await fakeT3({ change: ({ shell }) => {
    shell.threads[0].modelSelection.options = { reasoningEffort: 'high' };
  } });
  const client = server.client();
  try { await client.connect(); assert.ok(client.compatibility.ready); }
  finally { await client.close(); await server.close(); }
});

test('a changed runtime is detected before writes and revalidated without an allowlist edit', async () => {
  const server = await fakeT3({ version: '0.1.10' });
  const first = server.client();
  let second;
  try {
    await first.connect();
    await writeFile(server.runtimeFile, JSON.stringify({ ...server.runtime, pid: 124, serverVersion: '57.0.0' }));
    assert.equal(await first.runtimeUnchanged(), false);
    const count = server.calls.length;
    await assert.rejects(first.dispatch({ threadId: 'existing-work' }), /restarted or updated/);
    assert.equal(server.calls.length, count, 'No mutation is sent through a connection to the old runtime.');
    await first.close();
    second = await server.client().connect();
    assert.equal(second.compatibility.serverVersion, '57.0.0');
    assert.ok(second.connected);
  } finally { await first.close(); await second?.close(); await server.close(); }
});

test('incompatible snapshots stop before any command probe touches the server', async () => {
  const cases = [
    { change: ({ config }) => { delete config.providers; }, capability: 'provider snapshot' },
    { change: ({ shell }) => { delete shell.threads; }, capability: 'thread snapshot' },
    { change: ({ shell }) => { delete shell.threads[0].activeRunId; }, capability: 'thread snapshot' },
    { change: ({ projection }) => { delete projection.runs; }, capability: 'thread projection' },
    { change: ({ projection }) => { projection.thread.id = 'wrong-thread'; }, capability: 'thread projection' },
    { change: ({ shell }) => { shell.threads[0].modelSelection.options = [{ value: 'high' }]; }, capability: 'model selection' },
  ];
  for (const item of cases) {
    const server = await fakeT3(item);
    const client = server.client();
    try {
      await assert.rejects(client.connect(), e => e instanceof CompatibilityError && e.capability === item.capability);
      assert.ok(!client.connected);
      assert.ok(!server.calls.some(c => c.tag.includes('dispatchCommand') || c.tag.includes('forceStopThread')));
    } finally { await client.close(); await server.close(); }
  }
});

test('missing recovery methods and changed invalid-target behavior name the incompatible capability', async () => {
  for (const method of ['orchestration.dispatchCommand', 'orchestration.forceStopThread']) {
    const server = await fakeT3({ missingMethod: method });
    const client = server.client();
    try {
      await assert.rejects(client.connect(), e => e instanceof CompatibilityError && e.capability === method);
      assert.ok(server.calls.filter(c => c.tag.startsWith('orchestration.') && c.tag !== 'orchestration.getThreadProjection')
        .every(c => c.payload.threadId !== 'existing-work'));
    } finally { await client.close(); await server.close(); }
  }
  const server = await fakeT3({ acceptInvalidTarget: true });
  const client = server.client();
  try { await assert.rejects(client.connect(), /accepted an invalid-target capability probe/); }
  finally { await client.close(); await server.close(); }
});

test('missing required read and refresh methods identify the failing operation before recovery', async () => {
  for (const method of ['server.getConfig', 'server.refreshProviders', 'orchestration.getThreadProjection']) {
    const server = await fakeT3({ missingMethod: method });
    const client = server.client();
    try {
      await assert.rejects(client.connect(), e => e instanceof CompatibilityError && e.capability === method);
      assert.ok(!server.calls.some(c => c.tag === 'orchestration.dispatchCommand'));
    } finally { await client.close(); await server.close(); }
  }
});

test('a server that removes the HTTP protocol endpoint reports incompatibility rather than version mismatch', async () => {
  const server = await fakeT3({ shellStatus: 404 });
  const client = server.client();
  try { await assert.rejects(client.connect(), e => e instanceof CompatibilityError && /HTTP 404/.test(e.message)); }
  finally { await client.close(); await server.close(); }
});

test('projection identity checks do not silently accept a different conversation', () => {
  assert.throws(() => validateProjection({ thread: { id: 'other' } }, 'expected'), /identity mismatch/);
});
