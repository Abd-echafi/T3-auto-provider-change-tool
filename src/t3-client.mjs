import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import WebSocket from 'ws';
import { CompatibilityError, ORCHESTRATION_PROTOCOL, inspectCapabilities,
  validateProviders, validateShell, validateProjection } from './compatibility.mjs';

export { CompatibilityError } from './compatibility.mjs';

const execute = promisify(execFile);
const runtimeIdentity = runtime => JSON.stringify([runtime.origin, runtime.pid, runtime.startedAt, runtime.serverVersion]);

export class RpcError extends Error {
  constructor(tag) {
    super(`T3 rejected the request (${tag}).`);
    this.name = 'RpcError';
    this.tag = tag;
  }
}

// Never propagate CLI stdout/stderr: session issuance returns a bearer token.
async function cli(command, args) {
  try {
    return (await execute(command, args, { timeout: 20_000, maxBuffer: 1_000_000 })).stdout;
  } catch {
    throw new Error(`T3 CLI ${args.slice(0, 3).join(' ')} failed. Check that T3 is installed and running.`);
  }
}

export class T3Client {
  constructor({ t3Home, t3Command, writable = false }) {
    this.home = t3Home;
    this.command = t3Command;
    this.writable = writable;
    this.pending = new Map();
    this.nextId = 0;
  }

  async connect() {
    const runtime = JSON.parse(await readFile(join(this.home, 'userdata/server-runtime.json'), 'utf8'));
    const origin = new URL(runtime.origin);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
        !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
      throw new Error('Only a local T3 server is supported. Refusing to send credentials to a remote origin.');
    }
    this.origin = origin.origin;
    this.version = runtime.serverVersion;
    this.runtimeIdentity = runtimeIdentity(runtime);
    const args = ['auth', 'session', 'issue', '--base-dir', this.home,
      '--scope', 'orchestration:read'];
    if (this.writable) args.push('--scope', 'orchestration:operate');
    args.push('--ttl', '12h', '--label', 'T3 account failover', '--json');
    this.auth = JSON.parse(await cli(this.command, args));
    this.expiresAt = Date.parse(this.auth.expiresAt);
    try {
      const { ticket } = await this.http('/api/auth/websocket-ticket/rpc', 'POST');
      const url = new URL('/ws', this.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('wsTicket', ticket);
      url.searchParams.set('orchestrationProtocol', ORCHESTRATION_PROTOCOL);
      const socket = this.socket = new WebSocket(url, { handshakeTimeout: 10_000 });
      socket.on('error', () => this.rejectPending(new Error('T3 connection failed.')));
      socket.on('close', () => this.rejectPending(new Error('T3 connection closed.')));
      socket.on('message', data => this.receive(data));
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', () => reject(new Error('Could not open T3 RPC connection.')));
      });
      this.compatibility = await inspectCapabilities(this, this.writable);
    } catch (error) {
      await this.close();
      throw error;
    }
    return this;
  }

  async http(path, method = 'GET') {
    const response = await fetch(new URL(path, this.origin), {
      method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${this.auth.token}`, 'x-t3-orchestration-protocol': ORCHESTRATION_PROTOCOL },
    });
    if ([400, 404, 405, 406, 426].includes(response.status)) {
      throw new CompatibilityError(path, `HTTP ${response.status} for orchestration protocol ${ORCHESTRATION_PROTOCOL}`);
    }
    if (!response.ok) throw new Error(`T3 HTTP request failed (${response.status}).`);
    try { return await response.json(); }
    catch { throw new CompatibilityError(path, 'server did not return JSON'); }
  }

  receive(data) {
    let frames;
    try { frames = JSON.parse(data.toString()); } catch { return; }
    for (const frame of Array.isArray(frames) ? frames : [frames]) {
      if (frame._tag === 'Ping') {
        this.socket.send(JSON.stringify({ _tag: 'Pong' }));
        continue;
      }
      const pending = this.pending.get(String(frame.requestId));
      if (!pending || frame._tag !== 'Exit') continue;
      clearTimeout(pending.timer);
      this.pending.delete(String(frame.requestId));
      if (frame.exit?._tag === 'Success') pending.resolve(frame.exit.value);
      else {
        const cause = frame.exit?.cause;
        const reason = cause?.error?._tag ?? cause?.[0]?.error?._tag ?? 'RPC failure';
        pending.reject(new RpcError(reason));
      }
    }
  }

  rpc(tag, payload = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('T3 is disconnected.'));
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`T3 ${tag} timed out; any recovery command will be retried with the same ID.`));
        this.socket.terminate();
      }, 45_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }), error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Could not send the T3 request.'));
      });
    });
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async requiredRead(tag, payload = {}) {
    try { return await this.rpc(tag, payload); }
    catch (error) {
      if (error instanceof RpcError && /Unknown|MethodNotFound|InvalidRequest|Schema/.test(error.tag)) {
        throw new CompatibilityError(tag, `required method rejected the request (${error.tag})`);
      }
      throw error;
    }
  }

  async getConfig() { return validateProviders(await this.requiredRead('server.getConfig')); }
  async getShell() { return validateShell(await this.http('/api/orchestration/shell')); }
  async getProjection(threadId) {
    return validateProjection(await this.requiredRead('orchestration.getThreadProjection', { threadId }), threadId);
  }
  refreshProviders() { return this.requiredRead('server.refreshProviders'); }
  async releaseWriter(threadId, runId) {
    if (!this.writable) throw new Error('Writer release is disabled in read-only mode.');
    await this.requireWritableCapability('writer release');
    // T3 rejects this when a newer run superseded the stopped run. It also
    // protects other working threads that share the provider's process.
    return this.rpc('orchestration.forceStopThread', { threadId, runId });
  }
  async dispatch(command) {
    if (!this.writable) throw new Error('Recovery is disabled in read-only mode.');
    await this.requireWritableCapability('dispatch');
    return this.rpc('orchestration.dispatchCommand', command);
  }
  get connected() {
    return this.compatibility?.ready && this.socket?.readyState === WebSocket.OPEN && this.expiresAt > Date.now() + 60_000;
  }

  async runtimeUnchanged() {
    try {
      const runtime = JSON.parse(await readFile(join(this.home, 'userdata/server-runtime.json'), 'utf8'));
      return runtimeIdentity(runtime) === this.runtimeIdentity;
    } catch { return false; }
  }

  async requireWritableCapability(capability) {
    if (!this.compatibility?.ready || !this.compatibility.writable) {
      throw new CompatibilityError(capability, 'connection has not passed write capability validation');
    }
    if (!await this.runtimeUnchanged()) {
      this.socket?.terminate();
      throw new Error('T3 restarted or updated; reconnecting to revalidate its recovery interface.');
    }
  }

  async close() {
    this.compatibility = null;
    this.rejectPending(new Error('T3 client stopped.'));
    this.socket?.terminate();
    if (this.auth) {
      const sessionId = this.auth.sessionId;
      this.auth = null;
      // A crash can leave a token active until its TTL; no token is written to disk.
      await cli(this.command, ['auth', 'session', 'revoke', '--base-dir', this.home, sessionId]).catch(() => {});
    }
  }
}
