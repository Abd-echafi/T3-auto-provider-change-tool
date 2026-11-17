import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

export async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Serialize stale-lock reclamation, so two restart attempts cannot unlink
  // a lock the other process has just acquired. Fail closed if this tiny guard
  // is left behind by a crash; an operator can remove it after checking PIDs.
  const guard = `${path}.guard`;
  try { await mkdir(guard, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another watcher is acquiring the lock. If no watcher is running, remove ${guard}.`);
    throw error;
  }
  try {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid lock file: ${path}`);
      try { process.kill(pid, 0); }
      catch (err) {
        if (err.code === 'ESRCH') { await rm(path); continue; }
        throw err;
      }
      throw new Error(`A failover watcher is already running (PID ${pid}).`);
    }
  }
  throw new Error('Could not acquire watcher lock.');
  } finally { await rm(guard, { recursive: true, force: true }); }
}
