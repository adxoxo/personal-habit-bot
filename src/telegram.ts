import { Bot, BotError, GrammyError } from 'grammy';
import type { Update } from 'grammy/types';
import { Store, type Input, type Reply } from './store.js';
import { HabitService } from './service.js';
import { MENU } from './conversation.js';
import { ReminderScheduler, refreshNotification } from './reminders.js';

export function acceptUpdate(update: Update, allowedUserId: string, store: Store, now = new Date()): Input | undefined {
  const message = update.message;
  const callback = update.callback_query;
  if (message && message.chat.type === 'private' && String(message.from?.id) === allowedUserId && typeof message.text === 'string') {
    const input: Input = { updateId: update.update_id, sourceId: `${message.chat.id}:${message.message_id}`,
      chatId: message.chat.id, userId: message.from!.id, kind: 'text', text: message.text,
      at: new Date(message.date * 1000).toISOString() };
    store.transaction(()=>{store.enqueue(input);store.setSetting('chat_id',String(input.chatId));if(!store.getSetting('activated_at')) store.setSetting('activated_at',now.toISOString());}); return input;
  }
  if (callback?.message?.chat.type === 'private' && String(callback.from.id) === allowedUserId && callback.data) {
    const input: Input = { updateId: update.update_id, sourceId: 'callback:' + callback.id,
      chatId: callback.message.chat.id, userId: callback.from.id, kind: 'callback', text: callback.data, at: now.toISOString() };
    store.transaction(()=>{store.enqueue(input);store.setSetting('chat_id',String(input.chatId));if(!store.getSetting('activated_at')) store.setSetting('activated_at',now.toISOString());}); return input;
  }
  // Edited messages, groups, media, and other users never reach storage or the model.
  return undefined;
}

export interface Sender { send(chatId: number, reply: Reply): Promise<unknown> }
export async function flushOutbox(store: Store, sender: Sender, now = Date.now()): Promise<void> {
  const cooldown = store.db.prepare("SELECT value FROM meta WHERE key='telegram_pause_until'").get() as { value: string } | undefined;
  if (cooldown && Number(cooldown.value) > now) return;
  for (const row of store.outbox(now)) {
    const input = JSON.parse(row.payload) as Input;
    const reply=input.kind==='notification'?refreshNotification(store,input,now):JSON.parse(row.response!) as Reply;
    if(!reply) {store.discard(row.id,'expired_or_no_longer_due');continue;}
    try { await sender.send(input.chatId, reply); }
    catch (error) {
      const retryAfter = error instanceof GrammyError ? error.parameters.retry_after : undefined;
      const delay = retryAfter && retryAfter > 0 ? retryAfter * 1000 : Math.min(300000, 1000 * 2 ** Math.min(row.attempts + 1, 9));
      store.postpone(row.id, now + delay);
      if (retryAfter) {
        store.db.prepare("INSERT INTO meta(key,value) VALUES('telegram_pause_until',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(now + delay));
        break;
      }
      continue;
    }
    // Storage errors are fatal. A failed delivery never rolls back a habit write.
    store.markSent(row.id);
  }
}

export function installHandlers(bot: Bot, owner: string, store: Store, service: HabitService, now:()=>Date=()=>new Date()): () => Promise<void> {
  const sender: Sender = { send: (chatId, reply) => bot.api.sendMessage(chatId, reply.text, {
    reply_markup:reply.buttons?{inline_keyboard:reply.buttons}:{keyboard:MENU.map(row=>row.map(text=>({text}))),resize_keyboard:true,is_persistent:true},
    link_preview_options: { is_disabled: true },
  }) };
  const scheduler=new ReminderScheduler(store,store.getSetting('timezone')!,now);
  const tick = async () => { await service.drain();scheduler.tick(); await flushOutbox(store, sender,now().getTime()); };
  bot.use(async ctx => {
    const accepted = acceptUpdate(ctx.update, owner, store,now());
    if (!accepted) return;
    if (ctx.callbackQuery) {
      try { await ctx.answerCallbackQuery({ text: 'Check-in received.' }); }
      catch { /* An expired callback acknowledgement must not discard durable intake. */ }
    }
    await tick();
  });
  return tick;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

export async function pollTelegram(bot: Bot, signal: AbortSignal, tick: () => Promise<void>): Promise<void> {
  await bot.init();
  let offset: number | undefined, failures = 0;
  while (!signal.aborted) {
    await tick();
    let updates: Update[];
    try {
      const apiSignal = signal as unknown as NonNullable<Parameters<typeof bot.api.getUpdates>[1]>;
      updates = await bot.api.getUpdates({ offset, timeout: 20, allowed_updates: ['message', 'callback_query'] }, apiSignal);
      failures = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof GrammyError && [401, 403, 409].includes(error.error_code)) throw new Error('telegram_connection_rejected');
      failures++;
      if (failures >= 5) throw new Error('telegram_unavailable');
      const retry = error instanceof GrammyError ? error.parameters.retry_after : undefined;
      await delay(retry ? retry * 1000 : Math.min(15000, 1000 * 2 ** failures), signal);
      continue;
    }
    for (const update of updates) {
      if (signal.aborted) return;
      try { await bot.handleUpdate(update); }
      catch (error) { throw error instanceof BotError ? error.error : error; }
      // Intake is durable before Telegram receives the next acknowledgement offset.
      offset = update.update_id + 1;
    }
  }
}
