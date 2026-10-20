import 'dotenv/config';
import { resolve } from 'node:path';

export function config(env: NodeJS.ProcessEnv = process.env) {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim(), owner = env.ALLOWED_TELEGRAM_USER_ID?.trim();
  if (!botToken || !/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error('config_telegram_token_required');
  if (!owner || !/^[1-9]\d*$/.test(owner) || !Number.isSafeInteger(Number(owner))) throw new Error('config_user_id_required');
  const timezone = env.USER_TIMEZONE?.trim() || 'Asia/Manila';
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); }
  catch { throw new Error('config_timezone_invalid'); }
  return { botToken, owner, timezone, dataDir: resolve(env.DATA_DIR || './data'),
    aiKey: env.DEEPSEEK_API_KEY?.trim(), aiModel: env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash' };
}
