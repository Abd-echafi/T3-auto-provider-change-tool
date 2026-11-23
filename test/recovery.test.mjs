import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, validateConfig, newState, shellEligible, blockedRun, observeFailure, pickAccount, makeCommand, accountReason } from '../src/policy.mjs';
import { Watcher } from '../src/watcher.mjs';
import { T3Client, RpcError } from '../src/t3-client.mjs';
import { writeJson, readJson, acquireLock } from '../src/store.mjs';

const now = Date.parse('2026-11-16T16:00:00Z');
const iso = ms => new Date(ms).toISOString();

function provider(id, used = 20) {
  return { instanceId: id, driver: 'codex', enabled: true, installed: true, status: 'ready',
    auth: { status: 'authenticated', email: `${id}@example.test` },
    models: [{ slug: 'gpt-6.1-sol', capabilities: { optionDescriptors: [
      { id: 'reasoningEffort', type: 'select', options: [{ id: 'xhigh' }] },
      { id: 'serviceTier', type: 'select', options: [{ id: 'priority' }] },
    ] } }],
    usageLimits: { checkedAt: iso(now), windows: [
      { id: 'primary', kind: 'session', usedPercent: used, resetsAt: iso(now + 3_600_000) },
      { id: 'secondary', kind: 'weekly', usedPercent: 50 },
    ] },
  };
}
function fixture() {
  const state = newState(now - 60_000);
  const config = validateConfig({ accountOrder: ['a', 'b', 'c', 'd'] });
  const shell = { id: 'thread-1', projectId: 'project-1', providerInstanceId: 'a', status: 'failed',
    lastErrorClass: 'usage_limit', latestRunId: 'run-1', latestRunCompletedAt: iso(now - 1000),
    modelSelection: { instanceId: 'a', model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'xhigh' }, { id: 'serviceTier', value: 'priority' }] },
    runtimeMode: 'full-access', lineage: {},
  };
  const run = { id: 'run-1', providerInstanceId: 'a', status: 'failed', rootNodeId: 'root-1',
    ordinal: 1, userMessageId: 'message-1', completedAt: iso(now - 1000) };
  const failure = { class: 'usage_limit', resetAt: iso(now + 3_600_000) };
  const projection = { thread: structuredClone(shell), runs: [run], runtimeRequests: [],
    messages: [{ id: 'message-1', text: 'Finish the task.' }],
    turnItems: [{ id: 'err-1', runId: run.id, nodeId: run.rootNodeId, type: 'error', status: 'failed',
      ordinal: 3, updatedAt: iso(now - 1000), failure }],
  };
  return { state, config, shell, run, failure, projection, providers: [provider('a', 100), provider('b'), provider('c'), provider('d')] };
}

function antigravityFixture() {
  const f = fixture();
  const sourceId = 'antigravity_4';
  f.shell.providerInstanceId = f.run.providerInstanceId = sourceId;
  f.shell.modelSelection = { instanceId: sourceId, model: 'gemini-4-neon', options: [{ id: 'thought_level', value: 'medium' }] };
  f.projection.thread = structuredClone(f.shell);
  const account = (id, used) => ({
    ...provider(id), driver: 'antigravity',
    models: [{ slug: 'gemini-4-neon', capabilities: { optionDescriptors: [
      { id: 'thought_level', type: 'select', options: [{ id: 'medium' }] },
    ] } }],
    usageLimits: { checkedAt: iso(now), windows: [
      { id: '3p-5h', usedPercent: 100 }, { id: 'gemini-5h', usedPercent: used },
      { id: 'gemini-weekly', usedPercent: 10 }, { id: 'gemini-argon-wtu-weekly', usedPercent: 100 },
    ] },
  });
  const codex = { ...account('b', 0), driver: 'codex' };
  codex.usageLimits.windows = [{ id: 'primary', usedPercent: 0 }];
  f.providers = [account(sourceId, 100), codex,
    account('antigravity_5', 10), account('antigravity_6', 15)];
  return f;
}

test('selects the next usable account, wraps, and preserves all model options', () => {
  const f = fixture();
  assert.equal(pickAccount(f.providers, f.shell, f.state, f.config, now).instanceId, 'b');
  f.providers[1].usageLimits.windows[1].usedPercent = 100;
  f.providers[2].enabled = false;
  assert.equal(pickAccount(f.providers, f.shell, f.state, f.config, now).instanceId, 'd');
  f.shell.providerInstanceId = 'd';
  f.providers[0].usageLimits.windows[0].usedPercent = 10;
  assert.equal(pickAccount(f.providers, f.shell, f.state, f.config, now).instanceId, 'a');
  const command = makeCommand(f.projection.thread, f.run, 'b');
  assert.deepEqual(command.modelSelection, { ...f.shell.modelSelection, instanceId: 'b' });
  assert.equal(command.manualContinuationOfRunId, 'run-1');
  assert.equal(command.commandId, makeCommand(f.projection.thread, f.run, 'b').commandId);
});

test('each account order can only select accounts of the failed provider type', () => {
  const codex = fixture();
  codex.providers[1].driver = 'antigravity';
  assert.equal(pickAccount(codex.providers, codex.shell, codex.state, codex.config, now).instanceId, 'c');

  const ag = antigravityFixture();
  assert.equal(pickAccount(ag.providers, ag.shell, ag.state, ag.config, now).instanceId, 'antigravity_5');
  ag.config.antigravityAccountOrder = ['antigravity_4', 'b', 'antigravity_6', 'antigravity_5'];
  assert.equal(pickAccount(ag.providers, ag.shell, ag.state, ag.config, now).instanceId, 'antigravity_6');

  for (const account of ag.providers.slice(2)) account.usageLimits.windows[2].usedPercent = 100;
  assert.equal(pickAccount(ag.providers, ag.shell, ag.state, ag.config, now), null);
});

test('Antigravity uses quota for the selected model family and skips stale readings', () => {
  const f = antigravityFixture();
  f.providers[2].usageLimits.checkedAt = iso(now - 700_000);
  assert.equal(pickAccount(f.providers, f.shell, f.state, f.config, now).instanceId, 'antigravity_6');
  const target = f.providers[3];
  target.models.push({ slug: 'gemini-4-argon' }, { slug: 'claude-opus-5-5' });
  assert.equal(accountReason(target, { model: 'gemini-4-argon' }, f.state, f.config, now), 'quota exhausted');
  assert.equal(accountReason(target, { model: 'claude-opus-5-5' }, f.state, f.config, now), 'quota exhausted');
  target.usageLimits.windows = [{ id: 'claude-quota', usedPercent: 10 }];
  assert.equal(accountReason(target, { model: 'claude-opus-5-5' }, f.state, f.config, now), null);
  assert.equal(accountReason(target, f.shell.modelSelection, f.state, f.config, now), 'usage unknown for this model');
});

test('regression: real T3 option lists keep eligible accounts available', () => {
  const f = fixture();
  const selection = { ...f.shell.modelSelection, runtimeMode: f.shell.runtimeMode };
  assert.deepEqual(selection.options, [
    { id: 'reasoningEffort', value: 'xhigh' }, { id: 'serviceTier', value: 'priority' },
  ]);
  assert.equal(accountReason(f.providers[1], selection, f.state, f.config, now), null);
  const command = makeCommand(f.shell, f.run, pickAccount(f.providers, f.shell, f.state, f.config, now).instanceId);
  assert.deepEqual(command.modelSelection.options, selection.options);
  f.providers[1].models[0].capabilities.optionDescriptors[0].options = [{ id: 'medium' }];
  assert.equal(accountReason(f.providers[1], selection, f.state, f.config, now), 'model options unavailable');
  assert.equal(pickAccount(f.providers, f.shell, f.state, f.config, now).instanceId, 'c');
});

test('legacy dictionaries are accepted but malformed and duplicate option lists are rejected', () => {
  const f = fixture();
  const selection = { model: f.shell.modelSelection.model, options: { reasoningEffort: 'xhigh', serviceTier: 'priority' } };
  assert.equal(accountReason(f.providers[1], selection, f.state, f.config, now), null);
  for (const options of [[null], [{ id: 'reasoningEffort' }], [
    { id: 'reasoningEffort', value: 'xhigh' }, { id: 'reasoningEffort', value: 'medium' },
  ]]) assert.equal(accountReason(f.providers[1], { ...selection, options }, f.state, f.config, now), 'invalid model options');
});

test('skips stale, unknown, unauthenticated, incompatible, and duplicate accounts', () => {
  const changes = [
    p => { p.usageLimits.checkedAt = iso(now - 700_000); },
    p => { delete p.usageLimits; },
    p => { p.auth.status = 'unauthenticated'; },
    p => { p.models = []; },
    p => { p.models[0].capabilities.optionDescriptors = []; },
    p => { p.auth.email = 'a@example.test'; },
    p => { p.usageLimits.unavailable = { reason: 'probeFailed' }; },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f.providers[1]);
    assert.equal(pickAccount(f.providers, f.shell, f.state, f.config, now).instanceId, 'c');
  }
});

test('a usage-limit failure overrides a falsely positive cached reading', () => {
  const f = fixture();
  f.providers[1].usageLimits.windows[0].usedPercent = 0;
  observeFailure(f.state, { ...f.run, providerInstanceId: 'b' }, f.failure, f.config, now);
  assert.equal(pickAccount(f.providers, f.shell, f.state, f.config, now).instanceId, 'c');
  const observedAt = f.state.cooldowns.b.observedAt;
  observeFailure(f.state, { ...f.run, providerInstanceId: 'b' }, f.failure, f.config, now + 1000);
  assert.equal(f.state.cooldowns.b.observedAt, observedAt);
});

test('a refilled account becomes eligible only after its cooldown and a fresh probe', () => {
  const f = fixture();
  observeFailure(f.state, { ...f.run, providerInstanceId: 'b' }, { resetAt: iso(now + 1000) }, f.config, now);
  const later = now + 70_000;
  assert.equal(pickAccount(f.providers, f.shell, f.state, f.config, later).instanceId, 'c');
  f.providers[1].usageLimits.checkedAt = iso(later);
  assert.equal(pickAccount(f.providers, f.shell, f.state, f.config, later).instanceId, 'b');
});

test('two blocked threads on one account do not repeatedly extend its cooldown', () => {
  const f = fixture();
  const otherRun = { ...f.run, id: 'run-2' };
  observeFailure(f.state, f.run, { resetAt: null }, f.config, now);
  observeFailure(f.state, otherRun, { resetAt: null }, f.config, now);
  const until = f.state.cooldowns.a.until;
  for (const run of [f.run, otherRun, f.run, otherRun]) {
    observeFailure(f.state, run, { resetAt: null }, f.config, now + 20_000);
  }
  assert.equal(f.state.cooldowns.a.until, until);
  assert.equal(f.state.cooldowns.a.observedAt, now);
});

test('when the pool refills on the original account first, resumes there', () => {
  const f = fixture();
  f.providers.slice(1).forEach(p => { p.usageLimits.windows[1].usedPercent = 100; });
  observeFailure(f.state, f.run, { resetAt: iso(now + 1000) }, f.config, now);
  assert.equal(pickAccount(f.providers, f.shell, f.state, f.config, now), null);
  f.providers[0].usageLimits = { checkedAt: iso(now + 70_000), windows: [{ usedPercent: 0 }] };
  assert.equal(pickAccount(f.providers, f.shell, f.state, f.config, now + 70_000).instanceId, 'a');
});

test('never resumes old failures, running threads, approvals, settled or archived threads, or children', () => {
  const changes = [
    t => { t.latestRunCompletedAt = iso(now - 100_000); },
    t => { t.status = 'running'; }, t => { t.activeRunId = 'another-run'; },
    t => { t.pendingRuntimeRequest = { id: 'approval' }; },
    t => { t.pendingBackgroundTasks = [{ kind: 'command' }]; },
    t => { t.settledOverride = 'settled'; }, t => { t.archivedAt = iso(now); },
    t => { t.deletedAt = iso(now); }, t => { t.lastErrorClass = 'transport_error'; },
    t => { t.lineage.relationshipToParent = 'subagent'; },
    t => { t.snoozedUntil = iso(now + 100_000); },
  ];
  for (const change of changes) {
    const f = fixture(); change(f.shell);
    assert.equal(shellEligible(f.shell, f.config, f.state, now), false);
  }
  const f = fixture();
  assert.equal(shellEligible(f.shell, f.config, f.state, now), true);
  assert.equal(shellEligible(f.shell, { ...f.config, projectIds: ['other'] }, f.state, now), false);
  assert.equal(shellEligible(f.shell, { ...f.config, threadIds: ['other'] }, f.state, now), false);
});

test('projection recheck rejects queue races, changed account, pending input, and idle compaction', () => {
  const changes = [
    p => { p.runs.push({ id: 'queued', status: 'queued' }); },
    p => { p.runs.push({ id: 'active', status: 'running' }); },
    p => { p.runtimeRequests.push({ status: 'pending' }); },
    p => { p.thread.providerInstanceId = 'b'; },
    p => { p.thread.modelSelection.options.find(o => o.id === 'reasoningEffort').value = 'low'; },
    p => { p.messages[0].idleCompaction = 'beforeCacheExpires'; },
    p => { p.turnItems[0].failure.class = 'transport_error'; },
    p => { p.turnItems[0].nodeId = 'child-node'; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f.projection);
    assert.equal(blockedRun(f.projection, f.shell), null);
  }
  const f = fixture();
  assert.equal(blockedRun(f.projection, f.shell).run.id, f.run.id);
});

function harness(f, extra = {}) {
  const commands = [], saved = [], logs = [];
  const client = { refreshProviders: async () => {}, getConfig: async () => ({ providers: f.providers }),
    getShell: async () => ({ threads: [f.shell] }), getProjection: async () => structuredClone(f.projection),
    dispatch: async command => { commands.push(command); } };
  const watcher = new Watcher({ client, config: f.config, state: f.state, now: () => now,
    save: async state => saved.push(structuredClone(state)), log: row => logs.push(row),
    writerGuard: { probe: async () => ({ status: 'free' }) }, ...extra });
  return { watcher, client, commands, saved, logs };
}

test('an existing Codex config auto-discovers Antigravity and resumes it with its model options', async () => {
  const f = antigravityFixture();
  const h = harness(f, { writerGuard: { probe: async () => assert.fail('Codex writer check used for Antigravity') } });
  await h.watcher.tick();
  assert.equal(h.commands.length, 1);
  assert.equal(h.commands[0].manualContinuationOfRunId, f.run.id);
  assert.deepEqual(h.commands[0].modelSelection, { ...f.shell.modelSelection, instanceId: 'antigravity_5' });
  f.shell.latestRunId = 'run-2';
  f.shell.status = 'running';
  f.projection.runs.push({ id: 'run-2', status: 'running', userMessageId: h.commands[0].messageId });
  await h.watcher.tick();
  assert.equal(h.logs.at(-1).event, 'resume-confirmed');
  assert.equal(h.logs.at(-1).account, 'antigravity_5');
});

test('an explicit Antigravity account order limits which stopped threads are watched', async () => {
  const f = antigravityFixture();
  f.config.antigravityAccountOrder = ['antigravity_5', 'antigravity_6'];
  const h = harness(f);
  await h.watcher.tick();
  assert.equal(h.commands.length, 0);
  assert.equal(Object.keys(f.state.observedFailures).length, 0);
});

test('persists intent before dispatch and suppresses duplicate recovery on subsequent ticks and restart', async () => {
  const f = fixture(), h = harness(f);
  h.client.dispatch = async command => {
    assert.equal(h.saved.at(-1).attempts['thread-1:run-1'].status, 'pending');
    h.commands.push(command);
  };
  await h.watcher.tick(); await h.watcher.tick();
  assert.equal(h.commands.length, 1);
  const restarted = harness({ ...f, state: structuredClone(f.state) });
  await restarted.watcher.tick();
  assert.equal(restarted.commands.length, 0);
});

test('lost responses retry the identical durable command after restart', async () => {
  const f = fixture(), h = harness(f);
  let first;
  h.client.dispatch = async command => { first = structuredClone(command); throw new Error('Connection lost'); };
  await assert.rejects(h.watcher.tick(), /Connection lost/);
  const restarted = harness({ ...f, state: structuredClone(h.saved.at(-1)) });
  await restarted.watcher.tick();
  assert.deepEqual(restarted.commands, [first]);
});

test('holds continuation until the previous writer releases, then resumes once', async () => {
  const f = fixture();
  let held = true, releases = 0;
  const h = harness(f, { writerGuard: { probe: async () => ({ status: held ? 'held' : 'free' }) } });
  h.client.releaseWriter = async (threadId, runId) => {
    assert.equal(threadId, 'thread-1'); assert.equal(runId, 'run-1');
    assert.equal(h.saved.at(-1).attempts['thread-1:run-1'].writerRelease.status, 'pending');
    releases++; return { outcome: 'shared' };
  };
  await h.watcher.tick(); await h.watcher.tick();
  assert.equal(releases, 1); assert.equal(h.commands.length, 0);
  held = false;
  await h.watcher.tick(); await h.watcher.tick();
  assert.equal(h.commands.length, 1); assert.equal(releases, 1);
});

test('unknown writer ownership never stops a session or dispatches a message', async () => {
  const h = harness(fixture(), { writerGuard: { probe: async () => ({ status: 'unknown', reason: 'unavailable' }) } });
  h.client.releaseWriter = async () => { throw new Error('Must not stop a session'); };
  await h.watcher.tick();
  assert.equal(h.commands.length, 0);
  assert.match(h.logs[0].reason, /Cannot verify/);
});

test('a rejected guarded writer release prevents the account switch', async () => {
  const f = fixture();
  const h = harness(f, { writerGuard: { probe: async () => ({ status: 'held' }) } });
  h.client.releaseWriter = async () => { throw new RpcError('OrchestrationV2ForceStopThreadError'); };
  await h.watcher.tick(); await h.watcher.tick();
  assert.equal(h.commands.length, 0);
  assert.equal(f.state.attempts['thread-1:run-1'].status, 'release-rejected');
});

test('a prolonged lock wait keeps checking without repeatedly stopping the client', async () => {
  const f = fixture(); let time = now, held = true, releases = 0;
  const h = harness(f, { now: () => time, writerGuard: { probe: async () => ({ status: held ? 'held' : 'free' }) } });
  h.client.releaseWriter = async () => { releases++; return { outcome: 'released' }; };
  await h.watcher.tick();
  time += (f.config.writerReleaseWaitSeconds + 1) * 1000;
  await h.watcher.tick();
  assert.match(h.logs.at(-1).reason, /still held/);
  assert.equal(releases, 1); assert.equal(h.commands.length, 0);
  held = false; await h.watcher.tick();
  assert.equal(h.commands.length, 1);
});

test('quota is rechecked after a writer wait before the first dispatch', async () => {
  const f = fixture(); let held = true;
  const h = harness(f, { writerGuard: { probe: async () => ({ status: held ? 'held' : 'free' }) } });
  h.client.releaseWriter = async () => ({ outcome: 'released' });
  await h.watcher.tick();
  f.providers[1].usageLimits.windows[0].usedPercent = 100;
  held = false; await h.watcher.tick();
  assert.equal(h.commands[0].modelSelection.instanceId, 'c');
});

test('user model changes during a writer wait supersede the automatic recovery', async () => {
  const f = fixture(); let held = true;
  const h = harness(f, { writerGuard: { probe: async () => ({ status: held ? 'held' : 'free' }) } });
  h.client.releaseWriter = async () => ({ outcome: 'released' });
  await h.watcher.tick();
  f.shell.modelSelection.options.find(o => o.id === 'reasoningEffort').value = 'low';
  f.projection.thread.modelSelection.options.find(o => o.id === 'reasoningEffort').value = 'low';
  held = false; await h.watcher.tick();
  assert.equal(h.commands.length, 0);
  assert.equal(f.state.attempts['thread-1:run-1'].status, 'superseded');
});

test('distinguishes dispatch acceptance from a confirmed resumed turn', async () => {
  const f = fixture(), h = harness(f);
  await h.watcher.tick();
  assert.equal(h.logs.at(-1).event, 'continuation-requested');
  const attempt = f.state.attempts['thread-1:run-1'];
  f.shell.latestRunId = 'run-2'; f.shell.status = 'running';
  f.projection.runs.push({ id: 'run-2', status: 'running', userMessageId: attempt.command.messageId });
  await h.watcher.tick();
  assert.equal(h.logs.at(-1).event, 'resume-confirmed');
  assert.equal(attempt.status, 'resumed');
});

test('reports a writer conflict after acceptance without blindly replaying the task', async () => {
  const f = fixture(), h = harness(f);
  await h.watcher.tick();
  const attempt = f.state.attempts['thread-1:run-1'];
  f.shell.latestRunId = 'run-2'; f.shell.lastErrorClass = 'provider_error';
  f.projection.runs.push({ id: 'run-2', status: 'failed', userMessageId: attempt.command.messageId });
  f.projection.turnItems.push({ type: 'error', runId: 'run-2', failure: { message: 'This conversation is open in another Codex client.' } });
  await h.watcher.tick(); await h.watcher.tick();
  assert.equal(attempt.status, 'writer-conflict');
  assert.equal(h.commands.length, 1);
});

test('server rejection stops automatic retries for that run', async () => {
  const f = fixture(), h = harness(f);
  let called = 0;
  h.client.dispatch = async () => { called++; throw new RpcError('OrchestrationV2DispatchCommandError'); };
  await h.watcher.tick(); await h.watcher.tick();
  assert.equal(called, 1);
  assert.equal(f.state.attempts['thread-1:run-1'].status, 'rejected');
});

test('all accounts empty waits without sending, then recovers after a refresh', async () => {
  const f = fixture(), h = harness(f);
  f.providers.slice(1).forEach(p => { p.usageLimits.windows[0].usedPercent = 100; });
  await h.watcher.tick();
  assert.equal(h.commands.length, 0);
  f.providers[2].usageLimits.windows[0].usedPercent = 10;
  await h.watcher.tick();
  assert.equal(h.commands[0].modelSelection.instanceId, 'c');
});

test('blocked recovery logs the real rejection reason for every account', async () => {
  const f = fixture(), h = harness(f);
  f.providers.slice(1).forEach(p => { p.models[0].capabilities.optionDescriptors = []; });
  await h.watcher.tick();
  assert.equal(h.commands.length, 0);
  assert.equal(h.logs.at(-1).runId, f.run.id);
  assert.ok(h.logs.at(-1).accounts.filter(a => a.accountId !== 'a').every(a => a.reason === 'model options unavailable'));
  const count = h.logs.length;
  await h.watcher.tick(); assert.equal(h.logs.length, count);
  f.providers[1].models = provider('b').models;
  f.providers[1].usageLimits.windows[0].usedPercent = 100;
  await h.watcher.tick();
  assert.equal(h.logs.at(-1).accounts.find(a => a.accountId === 'b').reason, 'quota exhausted');
  assert.equal(h.logs.length, count + 1);
});

test('dry run never dispatches or persists recovery state', async () => {
  const h = harness(fixture(), { dryRun: true });
  await h.watcher.tick();
  assert.equal(h.saved.length, 0); assert.equal(h.commands.length, 0);
  assert.equal(h.logs[0].event, 'would-switch');
});

test('switch budget and scope prevent runaway or unrelated retries', async () => {
  const f = fixture(); f.config.maxSwitchesPerHour = 1;
  f.state.attempts.previous = { threadId: 'thread-1', at: now - 5000, status: 'accepted' };
  const h = harness(f); await h.watcher.tick();
  assert.equal(h.commands.length, 0);
  assert.match(h.logs[0].reason, /Hourly/);
});

test('RPC errors and disconnects reject pending calls without leaking server text', async () => {
  const c = new T3Client({});
  const promise = new Promise((resolve, reject) => c.pending.set('7', { resolve, reject, timer: setTimeout(() => {}, 1000) }));
  c.receive(Buffer.from(JSON.stringify({ _tag: 'Exit', requestId: '7', exit: { _tag: 'Failure', cause: {
    _tag: 'Fail', error: { _tag: 'OrchestrationV2DispatchCommandError', message: 'sensitive text' },
  } } })));
  await assert.rejects(promise, error => error instanceof RpcError && !error.message.includes('sensitive'));
  const disconnected = new Promise((resolve, reject) => c.pending.set('8', { resolve, reject, timer: setTimeout(() => {}, 1000) }));
  c.rejectPending(new Error('Disconnected'));
  await assert.rejects(disconnected, /Disconnected/);
  assert.equal(c.pending.size, 0);
});

test('state writes are private and atomic; the lock prevents two live watchers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 't3-failover-test-'));
  try {
    const path = join(dir, 'state.json'); await writeJson(path, newState(now));
    assert.equal((await readJson(path)).version, 1);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const unlock = await acquireLock(join(dir, 'watch.lock'));
    await assert.rejects(acquireLock(join(dir, 'watch.lock')), /already running/);
    await unlock();
    const unlockAgain = await acquireLock(join(dir, 'watch.lock')); await unlockAgain();
    await writeJson(path, { changed: true }); assert.deepEqual(JSON.parse(await readFile(path)), { changed: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid configuration fails instead of silently using unsafe defaults', () => {
  assert.throws(() => validateConfig({ pollSeconds: 0 }), /pollSeconds/);
  assert.throws(() => validateConfig({ accountOrder: ['a', 'a'] }), /accountOrder/);
  assert.throws(() => validateConfig({ accountOder: ['a'] }), /Unknown config/);
  assert.equal(validateConfig({}).pollSeconds, DEFAULTS.pollSeconds);
});
