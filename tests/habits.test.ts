import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { Bot, GrammyError } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { Store, type Input, type Reply } from '../src/store.js';
import { HabitService } from '../src/service.js';
import { addDays, dayAt, dailyStreak, weeklyStreak } from '../src/dates.js';
import { acceptUpdate, flushOutbox, installHandlers, pollTelegram } from '../src/telegram.js';
import { DeepSeekInterpreter, type Interpreter } from '../src/ai.js';
import { config } from '../src/config.js';
import { acquireLock, recoverLock } from '../src/lock.js';

const BOT_INFO: UserFromGetMe = {
  id: 456, is_bot: true, first_name: 'Habit', username: 'SyntheticHabitBot',
  can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};

class Harness {
  readonly directory = mkdtempSync(join(tmpdir(), 'habit-bot-test-'));
  readonly path = join(this.directory, 'habits.sqlite');
  now = new Date('2026-10-18T10:00:00Z');
  store = new Store(this.path, '123', 'Asia/Manila');
  service: HabitService;
  next = 0;
  constructor(t: TestContext, readonly ai?: Interpreter) {
    this.service = new HabitService(this.store, 'Asia/Manila', ai, () => this.now);
    t.after(() => { this.store.close(); rmSync(this.directory, { recursive: true, force: true }); });
  }
  input(text: string, kind: 'text' | 'callback' = 'text'): Input {
    const n = ++this.next;
    return { updateId: n, sourceId: (kind === 'text' ? '123:' : 'callback:') + n, chatId: 123, userId: 123, kind, text, at: this.now.toISOString() };
  }
  send(text: string, kind: 'text' | 'callback' = 'text'): Promise<Reply> { return this.service.process(this.store.enqueue(this.input(text, kind))); }
  reopen(): void {
    this.store.close(); this.store = new Store(this.path, '123', 'Asia/Manila');
    this.service = new HabitService(this.store, 'Asia/Manila', this.ai, () => this.now);
  }
}
function update(text: string, n = 1, user = 123): Update {
  return { update_id: n, message: { message_id: n, date: Date.parse('2026-10-18T10:00:00Z') / 1000,
    chat: { id: 123, type: 'private', first_name: 'Synthetic' }, from: { id: user, is_bot: false, first_name: 'Synthetic' }, text } };
}

test('first-use commands, daily completion, duplicate message, restart, and summary preserve record identity', async t => {
  const h = new Harness(t);
  assert.match((await h.send('/today')).text, /No active habits/);
  await h.send('/add Read | daily');
  const input = h.input('/done Read'), receipt = h.store.enqueue(input);
  const reply = await h.service.process(receipt);
  await h.service.process(h.store.enqueue(input));
  await h.service.process(h.store.enqueue({ ...input, updateId: 1000 }));
  assert.equal(h.store.logs(h.store.habits()[0]!.id).length, 1);
  assert.equal(h.store.logs(h.store.habits()[0]!.id)[0]!.source_id, input.sourceId);
  assert.match(reply.text, /1-day streak/);
  h.reopen();
  assert.match((await h.send('/today')).text, /Done · Read/);
  assert.match((await h.send('/week')).text, /Read: 1\/1 days so far/);
});

test('case and whitespace variants cannot create duplicate habits', async t => {
  const h = new Harness(t); await h.send('/add Read | daily');
  assert.match((await h.send('/add   READ | daily')).text, /already exists/);
  assert.equal(h.store.habits().length, 1);
});

test('skip and undo change only the selected habit and date', async t => {
  const h = new Harness(t); await h.send('/add Read'); await h.send('/add Walk');
  await h.send('/done Read'); await h.send('/skip Walk');
  assert.equal(h.store.logs(h.store.findHabit('Walk')!.id)[0]!.status, 'skipped');
  await h.send('/undo Read');
  assert.equal(h.store.logs(h.store.findHabit('Read')!.id).length, 0);
  assert.equal(h.store.logs(h.store.findHabit('Walk')!.id).length, 1);
});

test('repeated dated Done buttons are idempotent and do not toggle completion off', async t => {
  const h = new Harness(t); await h.send('/add Read');
  const callback = (await h.send('/today')).buttons![0]![0]!.callback_data;
  await h.send(callback, 'callback'); await h.send(callback, 'callback');
  assert.equal(h.store.logs(h.store.habits()[0]!.id).length, 1);
  assert.match((await h.send(callback, 'callback')).text, /already complete/);
  assert.ok(Buffer.byteLength(callback) <= 64);
});

test('yesterday buttons stay bound to their original day after local midnight', async t => {
  const h = new Harness(t); await h.send('/add Read');
  const callback = (await h.send('/today')).buttons![0]![0]!.callback_data;
  h.now = new Date('2026-10-18T16:01:00Z');
  await h.send(callback, 'callback');
  assert.equal(h.store.logs(h.store.habits()[0]!.id)[0]!.day, '2026-10-18');
  assert.match((await h.send('/today')).text, /Open · Read/);
});

test('a queued message uses its send date across local midnight', async t => {
  const h = new Harness(t); await h.send('/add Read');
  const receipt = h.store.enqueue(h.input('/done Read'));
  h.now = new Date('2026-10-18T16:01:00Z');
  await h.service.process(receipt);
  assert.equal(h.store.logs(h.store.habits()[0]!.id)[0]!.day, '2026-10-18');
});

test('invalid dates, future dates, and dates before creation cause no history write', async t => {
  const h = new Harness(t); await h.send('/add Read');
  for (const day of ['2026-02-30', '2026-10-19', '2026-10-17']) {
    await h.send('/done Read | ' + day);
    assert.equal(h.store.logs(h.store.habits()[0]!.id).length, 0);
  }
});

test('weekly targets, adjusted first week, and calendar streaks use unique days', async t => {
  const h = new Harness(t); h.now = new Date('2026-10-15T10:00:00Z');
  await h.send('/add Exercise | weekly 3');
  for (const day of ['2026-10-15', '2026-10-16', '2026-10-17']) {
    h.now = new Date(day + 'T10:00:00Z'); await h.send('/done Exercise');
  }
  h.now = new Date('2026-10-18T10:00:00Z');
  assert.match((await h.send('/week')).text, /3\/3 weekly goal.*1-week streak/);
  await h.send('/done Exercise');
  assert.match((await h.send('/week')).text, /4\/3 weekly goal/);
  await h.send('/add Walk | weekly 7'); await h.send('/done Walk');
  assert.match((await h.send('/week')).text, /Walk: 1\/1 weekly goal/);
});

test('daily and weekly streak helpers handle missed dates, future logs, and current periods', () => {
  assert.equal(dayAt(new Date('2026-10-18T16:00:00Z'), 'Asia/Manila'), '2026-10-19');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(dailyStreak(['2026-10-16', '2026-10-17', '2026-10-20'], '2026-10-18'), 2);
  assert.equal(dailyStreak(['2026-10-16'], '2026-10-18'), 0);
  assert.equal(weeklyStreak(['2026-10-12', '2026-10-14', '2026-10-16'], '2026-10-19', 3, '2026-10-12'), 1);
  assert.equal(weeklyStreak(['2026-10-12', '2026-10-14', '2026-10-16'], '2026-10-26', 3, '2026-10-12'), 0);
});

test('archive and resume preserve all prior history', async t => {
  const h = new Harness(t); await h.send('/add Read'); await h.send('/done Read');
  await h.send('/archive Read'); assert.equal(h.store.habits().length, 0);
  assert.match((await h.send('/done Read')).text, /archived/);
  assert.match((await h.send('/history Read')).text, /2026-10-18 · done/);
  await h.send('/resume Read'); assert.equal(h.store.habits().length, 1);
  assert.equal(h.store.logs(h.store.habits()[0]!.id).length, 1);
});

test('manual screen time accepts totals, replaces rather than adds, and rejects invalid values', async t => {
  const h = new Harness(t);
  await h.send('screen time: 2 hours'); assert.equal(h.store.screen('2026-10-18'), 120);
  await h.send('/screen 2h 15m'); assert.equal(h.store.screen('2026-10-18'), 135);
  for (const invalid of ['-1', '1441', '25h', '2.5h', 'unknown']) {
    await h.send('/screen ' + invalid); assert.equal(h.store.screen('2026-10-18'), 135);
  }
  assert.match((await h.send('/screen')).text, /manual/);
  await h.send('/screen 0'); assert.equal(h.store.screen('2026-10-18'), 0);
});

test('an AI check-in applies directly once and its Undo survives restart', async t => {
  let calls = 0;
  const ai: Interpreter = { interpret: async (_text, habits, day) => { calls++; return { kind: 'log', events: [{ habitId: habits[0]!.id, day, status: 'done' }] }; } };
  const h = new Harness(t, ai); await h.send('/add Read');
  const receipt = h.store.enqueue(h.input('I finished a chapter.'));
  const reply = await h.service.process(receipt);
  assert.equal(h.store.logs(h.store.habits()[0]!.id).length, 1);
  h.reopen(); await h.service.process(h.store.enqueue(JSON.parse(receipt.payload) as Input));
  assert.equal(calls, 1);
  await h.send(reply.buttons![0]![0]!.callback_data, 'callback');
  assert.equal(h.store.logs(h.store.habits()[0]!.id).length, 0);
});

test('legacy canceled and expired proposals cannot mutate history', async t => {
  const h = new Harness(t); await h.send('/add Read');
  const events = [{habitId:h.store.habits()[0]!.id,day:'2026-10-18',status:'done' as const}];
  const p = h.store.propose(events,'2026-10-18');
  await h.send('p:cancel:'+p.id,'callback'); await h.send('p:confirm:'+p.id,'callback');
  const q = h.store.propose(events,'2026-10-18'); h.now = new Date('2026-10-19T10:00:00Z');
  assert.match((await h.send('p:confirm:'+q.id,'callback')).text, /expired/);
  assert.equal(h.store.logs(h.store.habits()[0]!.id).length, 0);
});

test('AI unknown IDs, duplicate events, and partial-invalid batches never produce writes', async t => {
  let duplicate = false;
  const ai: Interpreter = { interpret: async (_text, habits, day) => ({ kind: 'log', events: [
    { habitId: habits[0]!.id, day, status: 'done' },
    { habitId: duplicate ? habits[0]!.id : 'aaaaaaaaaaaa', day, status: 'done' },
  ] }) };
  const h = new Harness(t, ai); await h.send('/add Read');
  assert.match((await h.send('I finished both.')).text, /Nothing was changed/);
  duplicate = true; assert.match((await h.send('I finished both again.')).text, /Nothing was changed/);
  assert.equal(h.store.logs(h.store.habits()[0]!.id).length, 0);
  assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM proposal').get()!.n, 0);
});

test('an archived habit invalidates a legacy outstanding proposal', async t => {
  const h = new Harness(t); await h.send('/add Read');
  const proposal = h.store.propose([{habitId:h.store.habits()[0]!.id,day:'2026-10-18',status:'done'}],'2026-10-18');
  await h.send('/archive Read');
  assert.match((await h.send('p:confirm:'+proposal.id,'callback')).text, /Nothing was changed/);
  assert.equal(h.store.logs(h.store.habits(true)[0]!.id).length, 0);
});

test('AI outage preserves the source and explicit commands still work', async t => {
  const h = new Harness(t, { interpret: async () => { throw new Error('synthetic provider failure'); } });
  await h.send('/add Read'); const input = h.input('I finished a chapter.');
  assert.match((await h.service.process(h.store.enqueue(input))).text, /AI is unavailable/);
  assert.equal(h.store.logs(h.store.habits()[0]!.id).length, 0);
  assert.equal(JSON.parse(h.store.db.prepare('SELECT payload FROM intake WHERE id=?').get(input.updateId)!.payload as string).text, input.text);
  await h.send('/done Read'); assert.equal(h.store.logs(h.store.habits()[0]!.id).length, 1);
});

test('a failed transaction rolls back both the habit effect and reply, then resumes safely', async t => {
  const h = new Harness(t); await h.send('/add Read');
  const original = h.store.log.bind(h.store), receipt = h.store.enqueue(h.input('/done Read'));
  h.store.log = (...args) => { original(...args); throw new Error('synthetic disk failure'); };
  await assert.rejects(h.service.process(receipt), /synthetic disk failure/);
  assert.equal(h.store.logs(h.store.habits()[0]!.id).length, 0);
  assert.equal(h.store.pending().length, 1);
  h.store.log = original; await h.service.drain(); assert.equal(h.store.logs(h.store.habits()[0]!.id).length, 1);
});

test('pending intake resumes after restart before any new Telegram message', async t => {
  const h = new Harness(t); await h.send('/add Read');
  h.store.enqueue(h.input('/done Read')); h.reopen(); await h.service.drain();
  assert.equal(h.store.logs(h.store.habits()[0]!.id).length, 1);
});

test('failed replies retry after restart without duplicate habit effects', async t => {
  const h = new Harness(t); await h.send('/add Read'); await h.send('/done Read');
  await flushOutbox(h.store, { send: async () => { throw new Error('offline'); } }, 100);
  assert.equal(h.store.status().replies, 2); h.reopen();
  const sent: Reply[] = []; await flushOutbox(h.store, { send: async (chat, reply) => { assert.equal(chat, 123); sent.push(reply); } }, 10000);
  assert.equal(sent.length, 2); assert.equal(h.store.status().replies, 0);
  assert.equal(h.store.logs(h.store.habits()[0]!.id).length, 1);
});

test('Telegram retry-after pauses every reply and survives restart', async t => {
  const h = new Harness(t); await h.send('/add Read'); await h.send('/today');
  let calls = 0;
  await flushOutbox(h.store, { send: async () => { calls++; throw new GrammyError('rate limit', { ok: false, error_code: 429, description: 'rate limit', parameters: { retry_after: 60 } }, 'sendMessage', {}); } }, 1000);
  h.reopen(); await flushOutbox(h.store, { send: async () => { calls++; } }, 2000);
  assert.equal(calls, 1);
  await flushOutbox(h.store, { send: async () => { calls++; } }, 62000);
  assert.equal(calls, 3);
});

test('groups, other users, edits, photos, and foreign callbacks never enter storage', t => {
  const h = new Harness(t);
  assert.equal(acceptUpdate(update('/add Read', 1, 999), '123', h.store), undefined);
  const group = update('/add Read', 2); group.message!.chat = { id: -123, type: 'group', title: 'Group' };
  assert.equal(acceptUpdate(group, '123', h.store), undefined);
  const edited: Update = { update_id: 3, edited_message: { ...update('edited').message!, edit_date: 1 } };
  assert.equal(acceptUpdate(edited, '123', h.store), undefined);
  assert.equal(acceptUpdate({ update_id: 4, message: { ...update('').message!, text: undefined, photo: [] } }, '123', h.store), undefined);
  const callback: Update = { update_id: 5, callback_query: { id: 'foreign', from: { id: 999, is_bot: false, first_name: 'Other' }, chat_instance: 'x', message: update('').message!, data: 'h:done:aaaaaaaaaaaa:2026-10-18' } };
  assert.equal(acceptUpdate(callback, '123', h.store), undefined);
  assert.equal(h.store.pending().length, 0);
});

test('real grammY handler routes synthetic messages and owner callbacks through SQLite to matching replies', async t => {
  let aiCalls = 0;
  const h = new Harness(t, { interpret: async () => { aiCalls++; return { kind: 'unknown' }; } });
  const bot = new Bot('123:synthetic', { botInfo: BOT_INFO });
  const replies: { chat_id: number; text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }[] = [];
  const methods: string[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    methods.push(method);
    if (method === 'sendMessage') replies.push(payload as typeof replies[number]);
    return { ok: true, result: { message_id: 500, date: 0, chat: { id: 123, type: 'private' }, text: 'synthetic' } } as never;
  });
  installHandlers(bot, '123', h.store, h.service);
  await bot.handleUpdate(update('/add Read'));
  await bot.handleUpdate(update('/done Read', 2));
  await bot.handleUpdate(update('foreign prose', 3, 999));
  assert.equal(aiCalls, 0); assert.equal(replies.length, 2);
  assert.equal(replies[1]!.chat_id, 123); assert.match(replies[1]!.text, /Read marked complete/);
  const log = h.store.logs(h.store.habits()[0]!.id)[0]!;
  assert.equal(log.source_id, '123:2'); assert.equal(log.day, '2026-10-18'); assert.equal(log.status, 'done');
  await bot.handleUpdate(update('/undo Read', 4));
  await bot.handleUpdate(update('/today', 5));
  const data = replies.at(-1)!.reply_markup!.inline_keyboard[0]![0]!.callback_data;
  const callback: Update = { update_id: 6, callback_query: {
    id: 'owner-done', from: { id: 123, is_bot: false, first_name: 'Synthetic' }, chat_instance: 'synthetic',
    message: update('').message!, data,
  } };
  await bot.handleUpdate(callback);
  const viaButton = h.store.logs(h.store.habits()[0]!.id)[0]!;
  assert.equal(viaButton.source_id, 'callback:owner-done');
  assert.equal(viaButton.day, '2026-10-18'); assert.equal(viaButton.status, 'done');
  assert.ok(methods.includes('answerCallbackQuery'));
  assert.match(replies.at(-1)!.text, /Read marked complete/);
  await bot.handleUpdate(callback);
  assert.equal(h.store.logs(h.store.habits()[0]!.id).length, 1);
});

test('poller acknowledges accepted updates only after durable intake and requests callbacks', async t => {
  const h = new Harness(t), controller = new AbortController();
  const bot = new Bot('123:synthetic', { botInfo: BOT_INFO });
  const requests: { offset?: number; allowed_updates?: string[] }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === 'getUpdates') {
      requests.push(payload as { offset?: number; allowed_updates?: string[] });
      if (requests.length === 1) return { ok: true, result: [update('/add Read', 42)] } as never;
      assert.equal(h.store.habits().length, 1); controller.abort(); return { ok: true, result: [] } as never;
    }
    return { ok: true, result: true } as never;
  });
  const tick = installHandlers(bot, '123', h.store, h.service);
  await pollTelegram(bot, controller.signal, tick);
  assert.equal(requests[1]!.offset, 43);
  assert.deepEqual(requests[0]!.allowed_updates, ['message', 'callback_query']);
});

test('database owner and timezone mismatches fail closed', t => {
  const h = new Harness(t);
  assert.throws(() => new Store(h.path, '999', 'Asia/Manila'), /database_identity_mismatch/);
  assert.throws(() => new Store(h.path, '123', 'Etc/UTC'), /database_identity_mismatch/);
  assert.equal(statSync(h.path).mode & 0o777, 0o600);
});

test('process lock preserves an active owner and recovery removes only a verified dead owner', t => {
  const dir = mkdtempSync(join(tmpdir(), 'habit-lock-test-')), path = join(dir, 'process.lock');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const release = acquireLock(path); assert.throws(() => acquireLock(path), /process_lock_exists/);
  assert.throws(() => recoverLock(path), /lock_owner_active/); release();
  assert.equal(recoverLock(path), false);
  writeFileSync(path, JSON.stringify({ pid: 2147483647, host: hostname() })); assert.equal(recoverLock(path), true);
  writeFileSync(path, JSON.stringify({ pid: 2147483647, host: 'another-host' })); assert.throws(() => recoverLock(path), /lock_identity_unknown/);
});

test('runtime config rejects missing credentials and invalid timezone without a live request', () => {
  assert.throws(() => config({}), /config_telegram_token_required/);
  assert.throws(() => config({ TELEGRAM_BOT_TOKEN: '123:fake', ALLOWED_TELEGRAM_USER_ID: 'x' }), /config_user_id_required/);
  assert.throws(() => config({ TELEGRAM_BOT_TOKEN: '123:fake', ALLOWED_TELEGRAM_USER_ID: '123', USER_TIMEZONE: 'invalid' }), /config_timezone_invalid/);
});

test('DeepSeek adapter validates structured JSON and rejects truncated or invalid responses', async () => {
  let body: Record<string, unknown> | undefined;
  const ai = new DeepSeekInterpreter('synthetic-key', 'synthetic-model', async (_url, init) => {
    body = JSON.parse(init!.body as string) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"kind":"unknown"}' } }] }));
  });
  assert.deepEqual(await ai.interpret('I will read later', [], '2026-10-18'), { kind: 'unknown' });
  assert.deepEqual(body!.response_format, { type: 'json_object' });
  for (const choice of [
    { finish_reason: 'length', message: { content: '{"kind":"unknown"}' } },
    { finish_reason: 'stop', message: { content: '{"kind":"delete_all"}' } },
    { finish_reason: 'stop', message: { content: '{"kind":"log","events":[]}' } },
  ]) {
    const bad = new DeepSeekInterpreter('synthetic', 'synthetic', async () => new Response(JSON.stringify({ choices: [choice] })));
    await assert.rejects(bad.interpret('text', [], '2026-10-18'), /ai_invalid_response/);
  }
});

test('maximum habit lists and summaries fit Telegram message limits', async t => {
  const h = new Harness(t);
  for (let i = 0; i < 20; i++) await h.send('/add ' + String(i).padStart(2, '0') + 'x'.repeat(58) + ' | daily');
  for (const command of ['/today', '/week', '/habits']) assert.ok((await h.send(command)).text.length <= 3900);
  assert.match((await h.send('/add One more')).text, /up to 20/);
});
