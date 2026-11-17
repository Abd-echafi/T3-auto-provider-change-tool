import { randomUUID } from 'node:crypto';

export const ORCHESTRATION_PROTOCOL = '2';

export class CompatibilityError extends Error {
  constructor(capability, detail) {
    super(`T3 recovery interface incompatible (${capability}): ${detail}. Automatic recovery is blocked.`);
    this.name = 'CompatibilityError';
    this.capability = capability;
  }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0;
const nullableId = value => value === null || id(value);
const requireShape = (condition, capability, detail) => {
  if (!condition) throw new CompatibilityError(capability, detail);
};

export function validateSelection(selection) {
  requireShape(record(selection) && id(selection.instanceId) && id(selection.model),
    'model selection', 'expected instanceId and model');
  const options = selection.options;
  if (options === undefined) return;
  requireShape(Array.isArray(options) || record(options), 'model selection', 'unrecognized options format');
  const entries = Array.isArray(options) ? options.map(o => [o?.id, o?.value]) : Object.entries(options);
  const seen = new Set();
  for (const [key, value] of entries) {
    requireShape(id(key) && !seen.has(key) && ['string', 'boolean'].includes(typeof value),
      'model selection', 'unrecognized or duplicate option entry');
    seen.add(key);
  }
}

export function validateProviders(config) {
  requireShape(record(config) && Array.isArray(config.providers), 'provider snapshot', 'missing providers array');
  for (const provider of config.providers) {
    requireShape(record(provider) && id(provider.instanceId) && id(provider.driver),
      'provider snapshot', 'missing provider identity');
    if (provider.driver !== 'codex' || !provider.enabled) continue;
    requireShape(typeof provider.installed === 'boolean' && id(provider.status) && record(provider.auth) &&
      id(provider.auth.status) && Array.isArray(provider.models), 'provider snapshot', 'incomplete Codex account state');
    for (const model of provider.models) {
      requireShape(record(model) && id(model.slug), 'model catalog', 'missing model slug');
      const descriptors = model.capabilities?.optionDescriptors;
      if (descriptors === undefined) continue;
      requireShape(Array.isArray(descriptors), 'model catalog', 'unrecognized option descriptors');
      for (const option of descriptors) {
        requireShape(record(option) && id(option.id) && id(option.type), 'model catalog', 'incomplete option descriptor');
        if (option.type === 'select') requireShape(Array.isArray(option.options) && option.options.every(o => id(o?.id)),
          'model catalog', 'unrecognized select values');
      }
    }
    const limits = provider.usageLimits;
    if (limits === undefined) continue; // Unavailable usage is an eligibility condition, not a protocol break.
    requireShape(record(limits) && Number.isFinite(Date.parse(limits.checkedAt)) && Array.isArray(limits.windows),
      'usage snapshot', 'missing quota timestamp or windows');
    for (const window of limits.windows) requireShape(record(window) && Number.isFinite(window.usedPercent) &&
      window.usedPercent >= 0 && window.usedPercent <= 100, 'usage snapshot', 'unrecognized quota percentage');
  }
  return config;
}

export function validateShell(snapshot) {
  requireShape(record(snapshot) && Array.isArray(snapshot.threads), 'thread snapshot', 'missing threads array');
  for (const thread of snapshot.threads) {
    requireShape(record(thread) && id(thread.id) && id(thread.providerInstanceId) && id(thread.status) &&
      nullableId(thread.activeRunId) && nullableId(thread.latestRunId), 'thread snapshot', 'missing thread/run identity or state');
    validateSelection(thread.modelSelection);
  }
  return snapshot;
}

export function validateProjection(projection, threadId) {
  requireShape(record(projection) && record(projection.thread) && projection.thread.id === threadId &&
    id(projection.thread.providerInstanceId), 'thread projection', 'thread identity mismatch');
  validateSelection(projection.thread.modelSelection);
  for (const key of ['runs', 'messages', 'turnItems', 'runtimeRequests', 'providerThreads']) {
    requireShape(Array.isArray(projection[key]), 'thread projection', `missing ${key} array`);
  }
  for (const run of projection.runs) requireShape(record(run) && id(run.id) && id(run.status) &&
    id(run.userMessageId) && id(run.providerInstanceId) && Number.isInteger(run.ordinal),
    'thread projection', 'incomplete run metadata');
  for (const request of projection.runtimeRequests) requireShape(record(request) && id(request.status),
    'thread projection', 'incomplete pending-request state');
  return projection;
}

async function expectTargetRejection(client, method, payload, expectedTag) {
  try {
    await client.rpc(method, payload);
  } catch (error) {
    if (error.name === 'RpcError') {
      requireShape(error.tag === expectedTag, method, `unexpected rejection ${error.tag}`);
      return;
    }
    throw error; // Connection problems remain retryable transport failures.
  }
  throw new CompatibilityError(method, 'server accepted an invalid-target capability probe');
}

export async function inspectCapabilities(client, writable) {
  let refreshedAt;
  if (writable) {
    await client.refreshProviders();
    refreshedAt = new Date().toISOString();
  }
  const [config, shell] = await Promise.all([client.getConfig(), client.getShell()]);
  // Read current shapes, accepting extra fields and any release label.
  validateProviders(config);
  validateShell(shell);
  const codex = new Set(config.providers.filter(p => p.driver === 'codex' && p.enabled).map(p => p.instanceId));
  const sample = shell.threads.find(t => codex.has(t.providerInstanceId) && t.latestRunId);
  if (sample) validateProjection(await client.getProjection(sample.id), sample.id);
  if (writable) {
    // Never probe a real thread with a deliberately wrong runId: a future
    // server that ignores that field could stop it. Both target IDs are new,
    // nonexistent UUIDs, and no thread creation method is ever called here.
    const probe = `failover-capability:${randomUUID()}`;
    await expectTargetRejection(client, 'orchestration.dispatchCommand', {
      type: 'message.dispatch', commandId: probe, messageId: probe,
      threadId: probe, manualContinuationOfRunId: probe,
      text: 'Invalid-target compatibility probe', attachments: [],
      createdBy: 'user', creationSource: 'mcp', dispatchMode: { type: 'start_immediately' },
      ...(sample ? { modelSelection: sample.modelSelection } : {}),
    }, 'OrchestrationV2DispatchCommandError');
    await expectTargetRejection(client, 'orchestration.forceStopThread', {
      threadId: probe, runId: probe,
    }, 'OrchestrationV2ForceStopThreadError');
  }
  return {
    ready: true, writable, protocol: ORCHESTRATION_PROTOCOL,
    serverVersion: client.version, checkedAt: new Date().toISOString(),
    ...(refreshedAt ? { refreshedAt } : {}),
    checks: [...(writable ? ['provider refresh'] : []), 'provider snapshot', 'thread snapshot', ...(sample ? ['thread projection'] : []),
      ...(writable ? ['dispatch rejection', 'writer-release rejection'] : [])],
  };
}
