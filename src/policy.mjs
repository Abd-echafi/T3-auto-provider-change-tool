import { createHash } from 'node:crypto';

export const DEFAULTS = {
  accountOrder: [], projectIds: [], threadIds: [],
  pollSeconds: 10, refreshSeconds: 300, usageMaxAgeSeconds: 600,
  failureMaxAgeHours: 336, maxSwitchesPerHour: 4,
  unknownResetCooldownSeconds: 300,
  writerReleaseWaitSeconds: 300,
};

export function newState(now = Date.now()) {
  return { version: 1, startedAt: new Date(now).toISOString(), cooldowns: {}, observedFailures: {}, attempts: {} };
}

export function validateConfig(input) {
  const config = { ...DEFAULTS, ...input };
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULTS) && !['t3Home', 't3Command', 'pythonCommand'].includes(key)) throw new Error(`Unknown config field: ${key}`);
  }
  for (const key of ['accountOrder', 'projectIds', 'threadIds']) {
    if (!Array.isArray(config[key]) || config[key].some(v => typeof v !== 'string' || !v.trim()) ||
        new Set(config[key]).size !== config[key].length) throw new Error(`${key} must be an array of unique, nonempty IDs.`);
  }
  for (const [key, min, max] of [
    ['pollSeconds', 2, 3600], ['refreshSeconds', 60, 3600], ['usageMaxAgeSeconds', 60, 3600],
    ['failureMaxAgeHours', 1, 720], ['maxSwitchesPerHour', 1, 20], ['unknownResetCooldownSeconds', 60, 3600],
    ['writerReleaseWaitSeconds', 10, 3600],
  ]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}.`);
    }
  }
  return config;
}

export function shellEligible(thread, config, state, now) {
  if (thread.status !== 'failed' || thread.lastErrorClass !== 'usage_limit' || thread.activeRunId ||
      thread.pendingRuntimeRequest || thread.archivedAt || thread.deletedAt ||
      (thread.pendingBackgroundTasks?.length ?? 0) > 0 ||
      thread.settledOverride === 'settled' || thread.lineage?.relationshipToParent === 'subagent') return false;
  if (config.projectIds.length && !config.projectIds.includes(thread.projectId)) return false;
  if (config.threadIds.length && !config.threadIds.includes(thread.id)) return false;
  if (config.accountOrder.length && !config.accountOrder.includes(thread.providerInstanceId)) return false;
  // Respect an explicit snooze, but allow T3's automatic usage-limit snooze.
  if (Date.parse(thread.snoozedUntil) > now && thread.limitRecovery?.runId !== thread.latestRunId) return false;
  const failedAt = Date.parse(thread.latestRunCompletedAt);
  return Number.isFinite(failedAt) && failedAt >= Date.parse(state.startedAt) &&
    now - failedAt <= config.failureMaxAgeHours * 3_600_000;
}

export function blockedRun(projection, shell) {
  const { thread, runs, runtimeRequests, turnItems } = projection;
  if (thread.archivedAt || thread.deletedAt || thread.settledOverride === 'settled' ||
      thread.providerInstanceId !== shell.providerInstanceId ||
      JSON.stringify(thread.modelSelection) !== JSON.stringify(shell.modelSelection) ||
      runtimeRequests.some(r => r.status === 'pending') ||
      runs.some(r => ['preparing', 'queued', 'starting', 'running', 'waiting'].includes(r.status))) return null;
  const run = runs.find(r => r.id === shell.latestRunId);
  if (!run || run.status !== 'failed' || run.providerInstanceId !== thread.providerInstanceId) return null;
  const latest = runs.filter(r => r.status !== 'queued' && !(r.status === 'cancelled' && !r.startedAt))
    .sort((a, b) => (Date.parse(b.completedAt) - Date.parse(a.completedAt)) || b.ordinal - a.ordinal)[0];
  if (latest?.id !== run.id) return null;
  const failure = turnItems.filter(i => i.type === 'error' && i.status === 'failed' &&
    i.runId === run.id && i.nodeId === run.rootNodeId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.ordinal - a.ordinal || b.id.localeCompare(a.id))[0]?.failure;
  if (failure?.class !== 'usage_limit') return null;
  const message = projection.messages.find(m => m.id === run.userMessageId);
  if (!message || message.idleCompaction) return null;
  // A context compaction is maintenance, not unfinished user work.
  if (turnItems.some(i => i.type === 'user_message' && i.messageId === run.userMessageId && i.idleCompaction)) return null;
  return { run, failure };
}

export function observeFailure(state, run, failure, config, now) {
  if (state.observedFailures[run.id]) return;
  state.observedFailures[run.id] = now;
  const current = state.cooldowns[run.providerInstanceId];
  state.cooldowns[run.providerInstanceId] = {
    runId: run.id, observedAt: now,
    until: Math.max(current?.until ?? 0, now + 60_000,
      Date.parse(failure.resetAt) || now + config.unknownResetCooldownSeconds * 1000),
  };
}

function identity(provider) {
  return provider.usageLimits?.credentialFingerprint ||
    (provider.auth?.email ? `${provider.auth.email}:${provider.auth.workspaceId ?? ''}` : provider.instanceId);
}

export function accountReason(provider, selection, state, config, now) {
  if (provider.driver !== 'codex' || !provider.enabled || !provider.installed || provider.status !== 'ready' ||
      provider.availability === 'unavailable' || provider.auth?.status !== 'authenticated') return 'unavailable';
  const model = provider.models?.find(m => m.slug === selection.model);
  if (!model) return 'model unavailable';
  if (provider.supportedRuntimeModes && selection.runtimeMode && !provider.supportedRuntimeModes.includes(selection.runtimeMode)) return 'runtime mode unavailable';
  // T3's ProviderOptionSelections wire format is [{ id, value }]. Keep a
  // legacy dictionary readable, but never interpret array indices as IDs.
  const options = Array.isArray(selection.options)
    ? selection.options.map(option => [option?.id, option?.value])
    : Object.entries(selection.options ?? {});
  const seen = new Set();
  for (const [key, value] of options) {
    if (typeof key !== 'string' || seen.has(key) || !['string', 'boolean'].includes(typeof value)) return 'invalid model options';
    seen.add(key);
    const descriptor = model.capabilities?.optionDescriptors?.find(d => d.id === key);
    if (!descriptor || (descriptor.type === 'select' && !descriptor.options.some(o => o.id === value))) return 'model options unavailable';
  }
  const limits = provider.usageLimits;
  if (!limits?.windows?.length || limits.unavailable) return 'usage unknown';
  const checkedAt = Date.parse(limits.checkedAt);
  if (!Number.isFinite(checkedAt) || now - checkedAt > config.usageMaxAgeSeconds * 1000) return 'usage stale';
  if (limits.windows.some(w => !Number.isFinite(w.usedPercent) || w.usedPercent >= 100)) return 'quota exhausted';
  const cooldown = state.cooldowns[provider.instanceId];
  if (cooldown && (now < cooldown.until || checkedAt <= cooldown.observedAt)) return 'recent limit; awaiting fresh quota';
  return null;
}

export function accountDiagnostics(providers, shell, state, config, now) {
  const source = providers.find(p => p.instanceId === shell.providerInstanceId);
  const ids = config.accountOrder.length ? config.accountOrder :
    providers.filter(p => p.driver === 'codex' && p.enabled).map(p => p.instanceId);
  return ids.map(id => {
    const provider = providers.find(p => p.instanceId === id);
    let reason = provider ? accountReason(provider,
      { ...shell.modelSelection, runtimeMode: shell.runtimeMode }, state, config, now) : 'account missing';
    if (id === shell.providerInstanceId) reason ??= 'current account';
    else if (provider && source && identity(provider) === identity(source)) reason = 'same account identity';
    return { accountId: id, reason: reason ?? 'eligible' };
  });
}

export function pickAccount(providers, shell, state, config, now) {
  const source = providers.find(p => p.instanceId === shell.providerInstanceId);
  if (source?.driver !== 'codex') return null;
  const ordered = config.accountOrder.length ? config.accountOrder :
    providers.filter(p => p.driver === 'codex' && p.enabled).map(p => p.instanceId);
  const pivot = ordered.indexOf(shell.providerInstanceId);
  if (pivot < 0) return null;
  // Try the next account in the configured order, wrapping at the end.
  const chain = [...ordered.slice(pivot + 1), ...ordered.slice(0, pivot)];
  const selection = { ...shell.modelSelection, runtimeMode: shell.runtimeMode };
  const next = chain.map(id => providers.find(p => p.instanceId === id)).find(p => p &&
    identity(p) !== identity(source) && !accountReason(p, selection, state, config, now));
  // If the whole pool was empty, the current account may refill first.
  if (!next && state.cooldowns[source.instanceId] && !accountReason(source, selection, state, config, now)) return source;
  return next ?? null;
}

export function makeCommand(thread, run, targetId) {
  const key = createHash('sha256').update(`${thread.id}:${run.id}:${targetId}`).digest('hex').slice(0, 32);
  return {
    type: 'message.dispatch', commandId: `failover:${key}`, messageId: `failover-message:${key}`,
    threadId: thread.id, text: 'Continue the unfinished task from where it stopped because the previous account reached its usage limit. Check the current state before repeating any action.',
    attachments: [], createdBy: 'user', creationSource: 'mcp',
    modelSelection: { ...structuredClone(thread.modelSelection), instanceId: targetId },
    manualContinuationOfRunId: run.id, dispatchMode: { type: 'start_immediately' },
  };
}
