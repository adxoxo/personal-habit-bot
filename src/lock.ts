import { openSync, writeFileSync, closeSync, readFileSync, unlinkSync, fsyncSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export function acquireLock(path: string): () => void {
  const owner = randomUUID();
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); } catch { throw new Error('process_lock_exists'); }
  try { writeFileSync(fd, JSON.stringify({ owner, pid: process.pid, host: hostname() })); fsyncSync(fd); }
  catch (error) { unlinkSync(path); throw error; }
  finally { closeSync(fd); }
  return () => {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { owner?: string };
    if (saved.owner === owner) unlinkSync(path);
  };
}

export function recoverLock(path: string): boolean {
  let saved: { pid?: number; host?: string };
  try { saved = JSON.parse(readFileSync(path, 'utf8')) as typeof saved; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new Error('lock_identity_unknown'); }
  if (saved.host !== hostname() || !Number.isSafeInteger(saved.pid) || saved.pid! <= 0) throw new Error('lock_identity_unknown');
  try { process.kill(saved.pid!, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('lock_owner_unverified');
    unlinkSync(path); return true;
  }
  throw new Error('lock_owner_active');
}
