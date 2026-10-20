import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Bot } from 'grammy';
import { config } from './config.js';
import { Store } from './store.js';
import { HabitService } from './service.js';
import { DeepSeekInterpreter } from './ai.js';
import { installHandlers, pollTelegram } from './telegram.js';
import { acquireLock, recoverLock } from './lock.js';

async function main(): Promise<void> {
  const options = config();
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const lockPath = join(options.dataDir, 'process.lock');
  if (process.argv.includes('--recover-lock')) {
    console.log(recoverLock(lockPath) ? 'Removed the verified dead process lock.' : 'No process lock exists.');
    return;
  }
  const release = acquireLock(lockPath), controller = new AbortController();
  const stop = () => controller.abort();
  let store: Store | undefined;
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    store = new Store(join(options.dataDir, 'habits.sqlite'), options.owner, options.timezone);
    const interpreter = options.aiKey ? new DeepSeekInterpreter(options.aiKey, options.aiModel) : undefined;
    const service = new HabitService(store, options.timezone, interpreter);
    const bot = new Bot(options.botToken, { client: { timeoutSeconds: 35 } });
    const tick = installHandlers(bot, options.owner, store, service);
    console.log('Habit bot starts locally. Send /start to your separate Telegram bot.');
    await pollTelegram(bot, controller.signal, tick);
  } finally {
    controller.abort(); store?.close(); release();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'unexpected_failure';
  console.error('Habit bot stopped: ' + code + '. Check README setup and recovery.');
  process.exitCode = 1;
});
