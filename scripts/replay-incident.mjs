// Read the last observed incident from T3, then replay it entirely in memory.
// Neither writer release nor message dispatch is sent to the real server.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { T3Client } from '../src/t3-client.mjs';
import { validateConfig } from '../src/policy.mjs';
import { Watcher } from '../src/watcher.mjs';

const config = validateConfig(JSON.parse(await readFile(join(homedir(), '.config/t3-account-failover/config.json'), 'utf8')));
const state = JSON.parse(await readFile(join(homedir(), '.local/state/t3-account-failover/state.json'), 'utf8'));
const incident = Object.values(state.cooldowns).sort((a, b) => b.observedAt - a.observedAt)[0];
assert.ok(incident, 'No recorded incident is available for replay.');
const threadId = /^run:thread:([^:]+):ordinal:\d+$/.exec(incident.runId)?.[1];
assert.ok(threadId, 'Unrecognized recorded run ID.');
const reader = await new T3Client(config).connect();
try {
  const liveConfig = await reader.getConfig();
  const snapshot = await reader.getProjection(threadId);
  // T3's initial projection omits older runs. Read just the incident's
  // historical records through SQLite's read-only mode; never edit the DB.
  const { stdout } = await promisify(execFile)(config.pythonCommand ?? '/usr/bin/python3', [
    fileURLToPath(new URL('./read-incident.py', import.meta.url)),
    join(config.t3Home, 'userdata/statev2.sqlite'), incident.runId,
  ], { timeout: 10_000, maxBuffer: 100_000 });
  const recorded = JSON.parse(stdout);
  const sourceRun = recorded.run;
  assert.ok(sourceRun, 'The stopped run is no longer available.');
  assert.ok(Array.isArray(sourceRun.modelSelection.options), 'Expected real T3 option-list data.');
  const failure = recorded.errors.find(i => i.nodeId === sourceRun.rootNodeId)?.failure;
  assert.equal(failure?.class, 'usage_limit');
  const original = { ...snapshot.thread, providerInstanceId: sourceRun.providerInstanceId,
    modelSelection: sourceRun.modelSelection, settledOverride: null, archivedAt: null, deletedAt: null,
    snoozedUntil: null, pendingBackgroundTasks: [], pendingRuntimeRequest: null };
  const shell = { ...original, latestRunId: sourceRun.id, latestRunCompletedAt: sourceRun.completedAt,
    activeRunId: null, status: 'failed', lastErrorClass: 'usage_limit' };
  const projection = { ...snapshot, thread: original,
    runs: [sourceRun], turnItems: recorded.errors, messages: [recorded.message], runtimeRequests: [] };
  // Reset only the in-memory copy; never rewrite the actual service history.
  state.attempts = {};
  const dispatched = [], releases = [], logs = [];
  let held = true;
  const simulated = {
    refreshProviders: async () => {}, getConfig: async () => liveConfig,
    getShell: async () => ({ threads: [structuredClone(shell)] }),
    getProjection: async () => structuredClone(projection),
    releaseWriter: async (...args) => { releases.push(args); return { outcome: 'shared' }; },
    dispatch: async command => { dispatched.push(structuredClone(command)); },
  };
  const watcher = new Watcher({ client: simulated, config, state, save: async () => {}, log: event => logs.push(event),
    writerGuard: { probe: async () => ({ status: held ? 'held' : 'free' }) } });
  await watcher.tick();
  assert.equal(releases.length, 1, JSON.stringify(logs));
  assert.equal(dispatched.length, 0, 'Must wait while the writer is held.');
  held = false;
  await watcher.tick();
  assert.equal(dispatched.length, 1, JSON.stringify(logs));
  assert.notEqual(dispatched[0].modelSelection.instanceId, sourceRun.providerInstanceId);
  assert.deepEqual(dispatched[0].modelSelection.options, sourceRun.modelSelection.options);
  const newRunId = 'simulation-only:continuation';
  Object.assign(shell, { status: 'running', latestRunId: newRunId, activeRunId: newRunId });
  projection.runs.push({ id: newRunId, userMessageId: dispatched[0].messageId, status: 'running' });
  await watcher.tick();
  assert.ok(logs.some(event => event.event === 'resume-confirmed'));
  assert.equal(dispatched.length, 1);
  console.log(JSON.stringify({ result: 'PASS', mode: 'in-memory replay of the recorded usage-limit failure',
    source: sourceRun.providerInstanceId, target: dispatched[0].modelSelection.instanceId,
    model: sourceRun.modelSelection.model, preservedOptions: dispatched[0].modelSelection.options,
    verified: ['writer release requested', 'waited for lock', 'selected eligible account', 'one continuation', 'resume confirmation'],
    liveWriterReleases: 0, liveMessageDispatches: 0 }));
} finally { await reader.close(); }
