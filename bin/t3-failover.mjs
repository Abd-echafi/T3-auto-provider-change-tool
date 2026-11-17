#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { T3Client, CompatibilityError } from '../src/t3-client.mjs';
import { ORCHESTRATION_PROTOCOL } from '../src/compatibility.mjs';
import { DEFAULTS, newState, validateConfig } from '../src/policy.mjs';
import { acquireLock, readJson, writeJson } from '../src/store.mjs';
import { Watcher } from '../src/watcher.mjs';

const execute = promisify(execFile);
const args = process.argv.slice(2);
const command = args.shift() ?? 'help';
let configPath = join(homedir(), '.config/t3-account-failover/config.json');
let stateDir = join(homedir(), '.local/state/t3-account-failover');
let dryRun = false, once = false, includeExisting = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' || args[i] === '--state-dir') {
    const flag = args[i++];
    if (!args[i] || args[i].startsWith('--')) throw new Error(`${flag} requires a path.`);
    if (flag === '--config') configPath = resolve(args[i]);
    else stateDir = resolve(args[i]);
  } else if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--once') once = true;
  else if (args[i] === '--include-existing') includeExisting = true;
  else throw new Error(`Unknown argument: ${args[i]}`);
}
const statePath = join(stateDir, 'state.json');
const healthPath = join(stateDir, 'health.json');
const log = record => console.log(JSON.stringify({ at: new Date().toISOString(), ...record }));

async function loadConfig() {
  const input = await readJson(configPath, {});
  return validateConfig({ ...input,
    t3Home: input.t3Home ?? process.env.T3CODE_HOME ?? join(homedir(), '.t3'),
    t3Command: input.t3Command ?? join(homedir(), '.t3/bin/t3'),
  });
}

function validateState(state) {
  if (state.version !== 1 || !Number.isFinite(Date.parse(state.startedAt)) ||
      !state.observedFailures || typeof state.observedFailures !== 'object' || Array.isArray(state.observedFailures) ||
      !state.cooldowns || typeof state.cooldowns !== 'object' || Array.isArray(state.cooldowns) ||
      !state.attempts || typeof state.attempts !== 'object' || Array.isArray(state.attempts)) {
    throw new Error(`Invalid recovery state in ${statePath}; refusing to discard recovery history.`);
  }
  return state;
}

async function init(config) {
  try { await readFile(configPath); throw new Error(`Config already exists: ${configPath}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const client = await new T3Client(config).connect();
  try {
    const { providers } = await client.getConfig();
    const accountOrder = providers.filter(p => p.driver === 'codex' && p.enabled).map(p => p.instanceId);
    if (accountOrder.length < 2) throw new Error('Connect at least two Codex accounts in T3 first.');
    await writeJson(configPath, { ...DEFAULTS, t3Home: config.t3Home, t3Command: config.t3Command, accountOrder });
    console.log(`Configured ${accountOrder.length} accounts: ${configPath}`);
  } finally { await client.close(); }
}

async function doctor(config) {
  const client = await new T3Client(config).connect();
  try {
    await client.refreshProviders();
    const { providers } = await client.getConfig();
    const shell = await client.getShell();
    console.log(`Connected to T3 ${client.version}. ${shell.threads.length} active threads.`);
    for (const p of providers.filter(p => p.driver === 'codex' && p.enabled)) {
      const quota = p.usageLimits?.windows?.map(w => `${w.label}: ${100 - w.usedPercent}% left`).join(', ') || 'usage unavailable';
      console.log(`${p.instanceId}: ${p.status}; ${quota}`);
    }
    console.log(`Config: ${configPath}`);
    console.log(`State: ${statePath}`);
    console.log(`Scope: ${config.threadIds.length ? config.threadIds.join(', ') : config.projectIds.length ? config.projectIds.join(', ') : 'all top-level Codex threads'}`);
    const conflicts = shell.threads.filter(t => /another Codex client|already has an active writer/i.test(t.lastError ?? ''));
    if (conflicts.length) console.log(`${conflicts.length} existing thread(s) report a writer conflict. Existing manual-switch failures are not automatically replayed.`);
    console.log(`Compatibility: orchestration protocol ${ORCHESTRATION_PROTOCOL}; app release number does not restrict connection.`);
    console.log(`Passed checks: ${client.compatibility.checks.join(', ')}.`);
    console.log('Credentials remain in memory; Codex login files are never opened.');
  } finally { await client.close(); }
}

async function watch(config) {
  const unlock = await acquireLock(join(stateDir, dryRun ? 'dry-run.lock' : 'watch.lock'));
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let client, watcher;
  const health = { pid: process.pid, startedAt: new Date().toISOString(), connected: false };
  try {
    const state = validateState(await readJson(statePath, newState()));
    if (includeExisting) state.startedAt = new Date(Date.now() - config.failureMaxAgeHours * 3_600_000).toISOString();
    if (!dryRun) await writeJson(statePath, state);
    log({ event: 'started', dryRun, pollSeconds: config.pollSeconds, watchingSince: state.startedAt });
    while (!abort.signal.aborted) {
      try {
        if (!client?.connected || !await client.runtimeUnchanged()) {
          await client?.close();
          client = new T3Client({ ...config, writable: !dryRun });
          await client.connect();
          watcher = new Watcher({ client, config, state, dryRun, save: value => writeJson(statePath, value), log });
          log({ event: 'connected', serverVersion: client.version, compatibility: client.compatibility });
        }
        await watcher.tick();
        Object.assign(health, { connected: true, serverVersion: client.version,
          lastSuccessfulPollAt: new Date().toISOString(), error: null, status: 'healthy',
          compatibility: client.compatibility });
        if (!dryRun) await writeJson(healthPath, health);
        if (once) break;
      } catch (error) {
        log({ event: 'error', message: error.message });
        Object.assign(health, { connected: client?.connected ?? false, error: error.message,
          status: error instanceof CompatibilityError ? 'blocked' : 'degraded',
          compatibility: client?.compatibility ?? null });
        if (!dryRun) await writeJson(healthPath, health);
        if (once) throw error;
      }
      try { await sleep(config.pollSeconds * 1000, undefined, { signal: abort.signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    }
  } finally {
    await client?.close();
    if (!dryRun) await writeJson(healthPath, { ...health, connected: false, status: 'stopped', stoppedAt: new Date().toISOString() });
    await unlock();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

const label = 'local.t3-account-failover';
const plistPath = join(homedir(), `Library/LaunchAgents/${label}.plist`);
const domain = `gui/${process.getuid?.()}`;
const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

async function service() {
  if (process.platform !== 'darwin') throw new Error('The service command currently supports macOS only. Use watch with your service manager elsewhere.');
  if (command === 'service-status') {
    try {
      const { stdout } = await execute('/bin/launchctl', ['print', `${domain}/${label}`]);
      console.log(stdout.split('\n').filter(l => /^\s*(state|pid|last exit code|runs) =/.test(l)).join('\n').trim());
      const health = await readJson(healthPath, null);
      const pid = Number(/^\s*pid = (\d+)/m.exec(stdout)?.[1]);
      if (health?.pid === pid) {
        console.log(`Recovery: ${health.status ?? (health.error ? 'degraded' : 'unknown')}`);
        if (health.compatibility?.ready) console.log(`Compatibility: protocol ${health.compatibility.protocol}, checked ${health.compatibility.checkedAt}`);
        const checked = Date.parse(health.lastSuccessfulPollAt);
        console.log(Number.isFinite(checked)
          ? `Last successful check: ${health.lastSuccessfulPollAt} (${Math.max(0, Math.round((Date.now() - checked) / 1000))} seconds ago)`
          : 'No successful check recorded for this process yet.');
        if (health.error) console.log(`Last check error: ${health.error}`);
      } else console.log('No current health record; process status alone does not confirm recovery is working.');
    } catch { console.log('Service is not loaded.'); }
    return;
  }
  if (command === 'service-uninstall') {
    await execute('/bin/launchctl', ['bootout', `${domain}/${label}`]).catch(() => {});
    await rm(plistPath, { force: true });
    console.log('Watcher service removed. Config and recovery history were kept.');
    return;
  }
  // Installation is an explicit CLI action. Never replace an existing service silently.
  try { await readFile(plistPath); throw new Error('Service is already installed. Uninstall it first to change its configuration.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const argv = [process.execPath, fileURLToPath(import.meta.url), 'watch', '--config', configPath, '--state-dir', stateDir];
  const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${argv.map(v => `<string>${xml(v)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(dirname(fileURLToPath(import.meta.url)))}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(join(stateDir, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(stateDir, 'service-error.log'))}</string>
</dict></plist>
`;
  await writeFile(plistPath, text, { mode: 0o600 });
  let loaded = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await execute('/bin/launchctl', ['bootstrap', domain, plistPath]);
      loaded = true;
      break;
    } catch (error) {
      // Immediately after bootout, launchd can still be reaping the old job
      // and transiently reject bootstrap with EIO (5).
      if (error.code !== 5 || attempt === 4) break;
      await sleep(250 * (attempt + 1));
    }
  }
  if (!loaded) {
    await rm(plistPath, { force: true });
    throw new Error('launchctl could not load the watcher. Run this from your logged-in macOS account.');
  }
  console.log(`Watcher installed and started. Log: ${join(stateDir, 'service.log')}`);
}

async function main() {
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`T3 account failover (capability checks / orchestration protocol ${ORCHESTRATION_PROTOCOL} / Codex)

  init                  Discover connected accounts and write config
  doctor                Verify the connection and show remaining quotas
  watch                 Resume new usage-limited threads automatically
  service-install       Install and start a macOS login service
  service-status        Show service state
  service-uninstall     Stop and remove the login service

Options: --config PATH, --state-dir PATH
Watch:   --dry-run, --once, --include-existing

New failures only by default. --include-existing opts into recent stopped threads.
All top-level Codex threads are watched; set projectIds or threadIds to narrow scope.`);
    return;
  }
  if (!['init', 'doctor', 'watch', 'service-install', 'service-status', 'service-uninstall'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command !== 'watch' && (dryRun || once || includeExisting)) throw new Error('Watch options are only valid with watch.');
  if (command.startsWith('service-')) return service();
  const config = await loadConfig();
  if (command === 'init') return init(config);
  if (command === 'doctor') return doctor(config);
  return watch(config);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
