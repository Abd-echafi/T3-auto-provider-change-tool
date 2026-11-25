import { SUPPORTED_DRIVERS, shellEligible, blockedRun, observeFailure, pickAccount, makeCommand, accountReason, accountDiagnostics } from './policy.mjs';
import { RpcError } from './t3-client.mjs';
import { WriterGuard } from './writer-guard.mjs';

export class Watcher {
  constructor({ client, config, state, save, log, dryRun = false, now = Date.now,
    writerGuard = new WriterGuard(config.pythonCommand) }) {
    Object.assign(this, { client, config, state, save, log, dryRun, now, writerGuard });
    this.lastRefresh = Date.parse(client.compatibility?.refreshedAt) || -Infinity;
    this.notices = new Map();
  }

  async confirmContinuations(threads) {
    for (const attempt of Object.values(this.state.attempts)) {
      if (attempt.status !== 'accepted' || !attempt.command?.messageId) continue;
      const shell = threads.find(t => t.id === attempt.threadId);
      if (!shell || shell.latestRunId === attempt.runId) continue;
      const projection = await this.client.getProjection(attempt.threadId);
      const run = projection.runs.find(r => r.userMessageId === attempt.command.messageId);
      if (!run) continue;
      if (['running', 'waiting', 'completed'].includes(run.status)) {
        attempt.status = 'resumed';
        attempt.continuationRunId = run.id;
        if (!this.dryRun) {
          await this.save(this.state);
          this.log({ event: 'resume-confirmed', threadId: attempt.threadId, runId: run.id, account: attempt.targetId });
        }
      } else if (['failed', 'interrupted', 'cancelled'].includes(run.status)) {
        const errors = projection.turnItems.filter(i => i.type === 'error' && i.runId === run.id);
        const conflict = errors.some(i => /another Codex client|already has an active writer/i.test(i.failure?.message ?? i.text ?? ''));
        attempt.status = conflict ? 'writer-conflict' : 'continuation-failed';
        attempt.continuationRunId = run.id;
        if (!this.dryRun) {
          await this.save(this.state);
          this.log({ event: attempt.status, threadId: attempt.threadId, runId: run.id,
            reason: conflict ? 'Writer ownership was not transferred. No automatic replay will be sent.' : 'The continuation ended before a successful resume was observed.' });
        }
      }
    }
  }

  async checkWriter(attempt, projection, shell, source) {
    const lock = await this.writerGuard.probe(projection, source);
    if (lock.status === 'unknown') {
      this.notice(shell.id, `Cannot verify writer release: ${lock.reason}.`);
      return 'blocked';
    }
    if (lock.status === 'free') return 'ready';
    if (!attempt.writerRelease) {
      // This phase is persisted before requesting a stop. On a lost response,
      // retry with the same source run guard, never an unguarded session detach.
      attempt.writerRelease = { at: this.now(), status: 'pending' };
      await this.save(this.state);
    }
    if (attempt.writerRelease.status === 'pending') {
      try {
        const result = await this.client.releaseWriter(shell.id, attempt.runId);
        attempt.writerRelease.status = 'requested';
        attempt.writerRelease.at = this.now();
        attempt.writerRelease.outcome = result.outcome;
        await this.save(this.state);
        this.log({ event: 'writer-release-requested', threadId: shell.id, runId: attempt.runId, outcome: result.outcome });
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        attempt.status = 'release-rejected';
        await this.save(this.state);
        this.notice(shell.id, 'T3 rejected writer release; the stopped run may have changed.');
        return 'blocked';
      }
    }
    const waitMs = this.now() - attempt.writerRelease.at;
    if (waitMs >= this.config.writerReleaseWaitSeconds * 1000) {
      this.notice(shell.id, 'Conversation writer is still held. Close its owning Codex client; automatic recovery is waiting.');
    } else this.notice(shell.id, 'Waiting for the old Codex client to release the conversation writer.');
    return waitMs < 10_000 ? 'retry-soon' : 'blocked';
  }

  notice(threadId, reason, details = {}) {
    const signature = JSON.stringify({ reason, ...details });
    if (this.notices.get(threadId) === signature) return;
    this.notices.set(threadId, signature);
    this.log({ event: 'waiting', threadId, reason, ...details });
  }

  async tick() {
    let nextPollMs = this.config.pollSeconds * 1000;
    const now = this.now();
    if (now - this.lastRefresh >= this.config.refreshSeconds * 1000) {
      await this.client.refreshProviders();
      this.lastRefresh = now;
    }
    const config = await this.client.getConfig();
    if (!Array.isArray(config.providers)) throw new Error('Unsupported T3 provider snapshot.');
    const { threads } = await this.client.getShell();
    if (!Array.isArray(threads)) throw new Error('Unsupported T3 thread snapshot.');
    await this.confirmContinuations(threads);
    for (const shell of threads) {
      const source = config.providers.find(p => p.instanceId === shell.providerInstanceId);
      if (!SUPPORTED_DRIVERS.includes(source?.driver) || !shellEligible(shell, this.config, this.state, now, source.driver)) continue;
      const projection = await this.client.getProjection(shell.id);
      const blocked = blockedRun(projection, shell);
      if (!blocked) {
        const run = projection.runs.find(r => r.id === shell.latestRunId);
        const missing = run && !projection.messages.some(m => m.id === run.userMessageId);
        this.notice(shell.id, missing ? 'Cannot verify whether the stopped run was maintenance: source message metadata is unavailable.'
          : 'Thread changed, has queued work, or needs user input.');
        continue;
      }
      const { run, failure } = blocked;
      observeFailure(this.state, run, failure, this.config, now);
      // Save source quarantine even when no account is currently usable.
      if (!this.dryRun) await this.save(this.state);
      const key = `${shell.id}:${run.id}`;
      let attempt = this.state.attempts[key];
      if (attempt && attempt.status !== 'pending') continue;
      if (!attempt) {
        const recent = Object.values(this.state.attempts).filter(a => a.threadId === shell.id &&
          now - a.at < 3_600_000 && a.status !== 'rejected');
        if (recent.length >= this.config.maxSwitchesPerHour) {
          this.notice(shell.id, 'Hourly switch limit reached; waiting.'); continue;
        }
        const target = pickAccount(config.providers, shell, this.state, this.config, now);
        if (!target) {
          this.notice(shell.id, 'No other account is eligible for this model.', {
            runId: run.id, accounts: accountDiagnostics(config.providers, shell, this.state, this.config, now),
          });
          continue;
        }
        attempt = {
          threadId: shell.id, runId: run.id, sourceId: run.providerInstanceId,
          targetId: target.instanceId, at: now, status: 'pending',
          sourceSelection: structuredClone(shell.modelSelection), sourceRuntimeMode: shell.runtimeMode,
          command: makeCommand(projection.thread, run, target.instanceId),
        };
      }
      if (this.dryRun) {
        this.log({ event: 'would-switch', threadId: shell.id, from: attempt.sourceId, to: attempt.targetId, runId: run.id });
        continue;
      }
      // A durable pending record and deterministic command ID make response loss retryable.
      this.state.attempts[key] = attempt;
      await this.save(this.state);
      if (attempt.sourceSelection && (JSON.stringify(shell.modelSelection) !== JSON.stringify(attempt.sourceSelection) ||
          shell.runtimeMode !== attempt.sourceRuntimeMode)) {
        attempt.status = 'superseded';
        await this.save(this.state);
        this.notice(shell.id, 'Thread settings changed during recovery; leaving them unchanged.');
        continue;
      }
      // Before the first send, account usage may change during a writer wait.
      // Once a send was attempted, preserve its ID and payload for replay.
      const target = config.providers.find(p => p.instanceId === attempt.targetId);
      if (!attempt.dispatchAttemptedAt) {
        const selection = { ...shell.modelSelection, runtimeMode: shell.runtimeMode };
        if (target?.driver !== source.driver || accountReason(target, selection, this.state, this.config, now)) {
          const replacement = pickAccount(config.providers, shell, this.state, this.config, now);
          if (!replacement) { this.notice(shell.id, 'Waiting for usable quota before resuming.'); continue; }
          attempt.targetId = replacement.instanceId;
          attempt.command = makeCommand(projection.thread, run, replacement.instanceId);
          await this.save(this.state);
        }
      } else if (target?.driver !== source.driver) {
        this.notice(shell.id, 'The original recovery target is no longer available in the same provider family.');
        continue;
      }
      // Codex can retain a native writer across an account switch. Antigravity
      // uses T3's provider handoff between isolated profiles instead.
      if (source.driver === 'codex') {
        const writer = await this.checkWriter(attempt, projection, shell, source);
        if (writer === 'retry-soon') nextPollMs = Math.min(nextPollMs, 500);
        if (writer !== 'ready') continue;
      }
      const current = (await this.client.getShell()).threads.find(t => t.id === shell.id);
      if (!current || !shellEligible(current, this.config, this.state, now, source.driver) || current.latestRunId !== run.id ||
          current.providerInstanceId !== shell.providerInstanceId || current.runtimeMode !== shell.runtimeMode ||
          JSON.stringify(current.modelSelection) !== JSON.stringify(shell.modelSelection) ||
          !blockedRun(await this.client.getProjection(shell.id), current)) {
        this.notice(shell.id, 'Thread changed while preparing to resume.');
        continue;
      }
      try {
        attempt.dispatchAttemptedAt ??= now;
        await this.save(this.state);
        await this.client.dispatch(attempt.command);
        attempt.status = 'accepted';
        await this.save(this.state);
        this.notices.delete(shell.id);
        this.log({ event: 'continuation-requested', threadId: shell.id, from: attempt.sourceId, to: attempt.targetId, runId: run.id });
      } catch (error) {
        if (error instanceof RpcError) {
          attempt.status = 'rejected';
          await this.save(this.state);
          this.notice(shell.id, 'T3 rejected the continuation; leaving this run for manual review.');
        } else throw error;
      }
    }
    return nextPollMs;
  }
}
