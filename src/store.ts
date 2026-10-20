import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { InputError } from './dates.js';

export type Habit = { id: string; name: string; cadence: 'daily' | 'weekly'; target: number; created_day: string; active: number;
  reminder_time: string | null; reminder_set_at: string; revision: number };
export type LogStatus = 'done' | 'skipped';
export type HabitEvent = { habitId: string; day: string; status: LogStatus };
export type Button = { text: string; callback_data: string };
export type Reply = { text: string; buttons?: Button[][]; menu?: boolean };
export type Notification = { day: string; habitIds: string[]; daily: boolean; expiresAt: number;
  dailyTime?: string; dailySetAt?: string; habits?: Record<string,{time:string;setAt:string}>;
  report?: boolean; reportTime?: string; reportSetAt?: string };
export type Input = {
  updateId: number; sourceId: string; chatId: number; userId: number;
  kind: 'text' | 'callback' | 'notification'; text: string; at: string; notification?: Notification;
};
export type Receipt = { id: number; payload: string; response: string | null; sent: number; retry_at: number; attempts: number };
export type Proposal = { id: string; events: string; state: 'open' | 'confirmed' | 'canceled'; created_day: string };
export const id = () => randomBytes(6).toString('hex');
export const normalizeName = (name: string) => name.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string, owner: string, timezone: string) {
    if (path !== ':memory:') {
      const parent = dirname(resolve(path));
      // Avoid chmod on a caller's existing parent directory.
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS habit (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
          cadence TEXT NOT NULL CHECK(cadence IN ('daily','weekly')), target INTEGER NOT NULL CHECK(target BETWEEN 1 AND 7),
          created_day TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
        CREATE TABLE IF NOT EXISTS habit_log (
          habit_id TEXT NOT NULL REFERENCES habit(id), day TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('done','skipped')), source_id TEXT NOT NULL,
          PRIMARY KEY(habit_id, day));
        CREATE TABLE IF NOT EXISTS intake (
          id INTEGER PRIMARY KEY, source_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
          response TEXT, sent INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS proposal (
          id TEXT PRIMARY KEY, events TEXT NOT NULL, created_day TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','confirmed','canceled')));
        CREATE TABLE IF NOT EXISTS screen_time (
          day TEXT PRIMARY KEY, minutes INTEGER NOT NULL CHECK(minutes BETWEEN 0 AND 1440),
          source_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual' CHECK(source='manual'));
      `);
      this.transaction(() => {
        for (const [key, value] of [['owner', owner], ['timezone', timezone]]) {
          const prior = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key!) as { value: string } | undefined;
          if (prior && prior.value !== value) throw new Error('database_identity_mismatch');
          this.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)').run(key!, value!);
        }
        const version = this.getSetting('schema_version');
        if (version && !['1', '2'].includes(version)) throw new Error('database_version_unknown');
        if (version !== '2') {
          this.db.exec(`ALTER TABLE habit ADD COLUMN reminder_time TEXT DEFAULT '08:00';
            ALTER TABLE habit ADD COLUMN reminder_set_at TEXT NOT NULL DEFAULT '';
            ALTER TABLE habit ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE intake ADD COLUMN discard_reason TEXT;
            CREATE TABLE conversation (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL);
            CREATE TABLE undo_action (id TEXT PRIMARY KEY, action TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE reminder_occurrence (key TEXT PRIMARY KEY, intake_id INTEGER);
          `);
          this.setSetting('schema_version', '2');
        }
      });
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  enqueue(input: Input): Receipt {
    const prior = this.db.prepare('SELECT * FROM intake WHERE id=? OR source_id=?').get(input.updateId, input.sourceId) as Receipt | undefined;
    if (prior) return prior;
    this.db.prepare('INSERT INTO intake(id,source_id,payload) VALUES(?,?,?)').run(input.updateId, input.sourceId, JSON.stringify(input));
    return this.db.prepare('SELECT * FROM intake WHERE id=?').get(input.updateId) as Receipt;
  }
  pending(): Receipt[] { return this.db.prepare('SELECT * FROM intake WHERE response IS NULL ORDER BY id').all() as Receipt[]; }
  commitReply(updateId: number, effect: () => Reply): Reply {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM intake WHERE id=?').get(updateId) as Receipt | undefined;
      if (!row) throw new Error('missing_intake');
      if (row.response) return JSON.parse(row.response) as Reply;
      const reply = effect();
      if (reply.text.length > 3900) throw new Error('reply_too_long');
      this.db.prepare('UPDATE intake SET response=? WHERE id=?').run(JSON.stringify(reply), updateId);
      return reply;
    });
  }
  outbox(now: number): Receipt[] { return this.db.prepare('SELECT * FROM intake WHERE response IS NOT NULL AND sent=0 AND retry_at<=? ORDER BY id').all(now) as Receipt[]; }
  markSent(updateId: number): void { this.db.prepare('UPDATE intake SET sent=1 WHERE id=?').run(updateId); }
  postpone(updateId: number, until: number): void { this.db.prepare('UPDATE intake SET retry_at=?, attempts=attempts+1 WHERE id=?').run(until, updateId); }
  status(): { pending: number; replies: number } {
    return { pending: Number((this.db.prepare('SELECT count(*) AS n FROM intake WHERE response IS NULL').get() as { n: number }).n),
      replies: Number((this.db.prepare('SELECT count(*) AS n FROM intake WHERE response IS NOT NULL AND sent=0').get() as { n: number }).n) };
  }
  habits(includeArchived = false): Habit[] {
    return this.db.prepare('SELECT * FROM habit ' + (includeArchived ? '' : 'WHERE active=1 ') + 'ORDER BY rowid').all() as Habit[];
  }
  habit(habitId: string): Habit | undefined { return this.db.prepare('SELECT * FROM habit WHERE id=?').get(habitId) as Habit | undefined; }
  findHabit(name: string): Habit | undefined {
    return this.db.prepare('SELECT * FROM habit WHERE name_key=? OR id=?').get(normalizeName(name), name.trim()) as Habit | undefined;
  }
  addHabit(name: string, cadence: 'daily' | 'weekly', target: number, day: string): Habit {
    name = name.replace(/\s+/g, ' ').trim();
    if (!name || name.length > 60 || /[|\x00-\x1f]/.test(name)) throw new InputError('Use a habit name of 1–60 characters without the | symbol.');
    if (this.habits(true).length >= 20) throw new InputError('This personal bot supports up to 20 habits.');
    if (this.findHabit(name)) throw new InputError('That habit already exists. Use /resume if it is archived.');
    const habitId = id();
    this.db.prepare('INSERT INTO habit(id,name,name_key,cadence,target,created_day) VALUES(?,?,?,?,?,?)').run(habitId, name, normalizeName(name), cadence, target, day);
    return this.habit(habitId)!;
  }
  setActive(habitId: string, active: boolean): void { this.db.prepare('UPDATE habit SET active=?,revision=revision+1 WHERE id=?').run(Number(active), habitId); }
  log(habitId: string, day: string, status: LogStatus, source: string): void {
    this.db.prepare('INSERT INTO habit_log(habit_id,day,status,source_id) VALUES(?,?,?,?) ON CONFLICT(habit_id,day) DO UPDATE SET status=excluded.status,source_id=excluded.source_id').run(habitId, day, status, source);
  }
  undo(habitId: string, day: string): void { this.db.prepare('DELETE FROM habit_log WHERE habit_id=? AND day=?').run(habitId, day); }
  logs(habitId: string): { day: string; status: LogStatus; source_id: string }[] {
    return this.db.prepare('SELECT day,status,source_id FROM habit_log WHERE habit_id=? ORDER BY day').all(habitId) as { day: string; status: LogStatus; source_id: string }[];
  }
  proposal(proposalId: string): Proposal | undefined { return this.db.prepare('SELECT * FROM proposal WHERE id=?').get(proposalId) as Proposal | undefined; }
  propose(events: HabitEvent[], day: string): Proposal {
    const proposalId = id(); this.db.prepare('INSERT INTO proposal(id,events,created_day) VALUES(?,?,?)').run(proposalId, JSON.stringify(events), day);
    return this.proposal(proposalId)!;
  }
  resolveProposal(proposalId: string, state: 'confirmed' | 'canceled'): void { this.db.prepare('UPDATE proposal SET state=? WHERE id=?').run(state, proposalId); }
  screen(day: string): number | undefined {
    return (this.db.prepare('SELECT minutes FROM screen_time WHERE day=?').get(day) as { minutes: number } | undefined)?.minutes;
  }
  saveScreen(day: string, minutes: number, source: string): void {
    this.db.prepare('INSERT INTO screen_time(day,minutes,source_id) VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET minutes=excluded.minutes,source_id=excluded.source_id').run(day, minutes, source);
  }
  getSetting(key: string): string | undefined { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value: string} | undefined)?.value; }
  setSetting(key: string, value: string): void { this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  setReminder(habitId: string, time: string | null, at: string): void {
    this.db.prepare('UPDATE habit SET reminder_time=?,reminder_set_at=?,revision=revision+1 WHERE id=?').run(time, at, habitId);
  }
  conversation(): unknown {
    const saved = this.db.prepare('SELECT state FROM conversation WHERE id=1').get() as {state: string} | undefined;
    return saved ? JSON.parse(saved.state) : undefined;
  }
  setConversation(state: unknown): void {
    if (state === undefined) this.db.prepare('DELETE FROM conversation').run();
    else this.db.prepare('INSERT INTO conversation(id,state) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(JSON.stringify(state));
  }
  saveUndo(action: unknown): string {
    const actionId = id(); this.db.prepare('INSERT INTO undo_action(id,action) VALUES(?,?)').run(actionId, JSON.stringify(action)); return actionId;
  }
  undoAction(actionId: string): {action: string; used: number} | undefined {
    return this.db.prepare('SELECT action,used FROM undo_action WHERE id=?').get(actionId) as {action: string; used: number} | undefined;
  }
  useUndo(actionId: string): void { this.db.prepare('UPDATE undo_action SET used=1 WHERE id=?').run(actionId); }
  occurred(key: string): boolean { return Boolean(this.db.prepare('SELECT key FROM reminder_occurrence WHERE key=?').get(key)); }
  markOccurrence(key: string, intakeId: number | null = null): void {
    this.db.prepare('INSERT OR IGNORE INTO reminder_occurrence(key,intake_id) VALUES(?,?)').run(key, intakeId);
  }
  queueNotification(keys: string[], chatId: number, notification: Notification, reply: Reply, at: string): void {
    const updateId = Math.min(0, Number((this.db.prepare('SELECT min(id) AS n FROM intake').get() as {n: number | null}).n ?? 0)) - 1;
    const input: Input = { updateId, sourceId: 'scheduled:' + keys.join(','), chatId, userId: chatId, kind: 'notification', text: '', at, notification };
    this.db.prepare('INSERT INTO intake(id,source_id,payload,response) VALUES(?,?,?,?)').run(updateId, input.sourceId, JSON.stringify(input), JSON.stringify(reply));
    for (const key of keys) this.markOccurrence(key, updateId);
  }
  discard(updateId: number, reason: string): void { this.db.prepare('UPDATE intake SET sent=2,discard_reason=? WHERE id=?').run(reason, updateId); }
}
