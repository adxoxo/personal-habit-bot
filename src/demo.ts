import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Store, type Input } from './store.js';
import { HabitService } from './service.js';
import { flushOutbox } from './telegram.js';

const directory = mkdtempSync(join(tmpdir(), 'habit-bot-demo-'));
let store: Store | undefined;
try {
  const now = new Date('2026-10-18T10:00:00Z');
  store = new Store(join(directory, 'habits.sqlite'), '123', 'Asia/Manila');
  let service = new HabitService(store, 'Asia/Manila', undefined, () => now);
  let next = 0;
  const message = (text: string): Input => ({ updateId: ++next, sourceId: '123:' + next,
    chatId: 123, userId: 123, kind: 'text', text, at: now.toISOString() });
  const create = message('/add Read | daily');
  console.log((await service.process(store.enqueue(create))).text);
  const done = message('/done Read');
  console.log((await service.process(store.enqueue(done))).text);
  await service.process(store.enqueue(done));
  assert.equal(store.logs(store.habits()[0]!.id).length, 1);
  await flushOutbox(store, { send: async () => { throw new Error('synthetic network failure'); } }, 100);
  store.close(); store = new Store(join(directory, 'habits.sqlite'), '123', 'Asia/Manila');
  service = new HabitService(store, 'Asia/Manila', undefined, () => now);
  const replies: string[] = [];
  await flushOutbox(store, { send: async (_chat, reply) => { replies.push(reply.text); } }, 10000);
  assert.equal(replies.length, 2);
  console.log((await service.process(store.enqueue(message('/week')))).text);
  assert.equal(store.logs(store.habits()[0]!.id).length, 1);
  console.log('Offline proof passed: create, log, duplicate, reply failure, restart, and summary. No network calls.');
} finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
