# Personal Habit Bot

Your private Telegram habit tracker. Talk normally or use its buttons. No slash commands are needed for daily use.

The daily check-in and new habit reminders default to **8 AM in Asia/Manila**.
Your separate daily streak report defaults to **11 PM in Asia/Manila**.

The app is separate from Personal AI Inbox and Grimoire.
It stores habit records in its own local SQLite database.
The local build, offline flow, and synthetic Telegram adapter and scheduler tests pass.
Live Telegram use needs your separate bot credentials and a real phone check-in.

## Start here

Use Node.js 24 or newer. Run these commands from this directory:

```bash
npm ci
npm test
npm run demo
cp .env.example .env
chmod 600 .env
```

Create a separate bot through Telegram's verified **@BotFather**, with `/newbot`.
Enter its token directly in `.env`. Set your numeric Telegram user ID in `ALLOWED_TELEGRAM_USER_ID`.
Use a different token from Personal AI Inbox. Two processes cannot poll the same bot.
Keep `USER_TIMEZONE=Asia/Manila` unless you want another timezone before first use.
The database binds its owner and timezone at first use. Later mismatches stop the app.

Commands and buttons work without AI. For free text, set your personal DeepSeek key and model in this app's `.env`.
The app never reads another project's environment file or credentials.
No Notion destination or Android account connection is required.

After setup:

```bash
npm run build
npm start
```

Open your new bot in Telegram and tap **Start**. The menu appears, and the daily schedule becomes active.
No sample habits enter the live database. Add your own habit first.
The app stays in the foreground. Keep its host and process available.
Use Ctrl+C for a normal shutdown. No automatic-start service is installed.

## Habit flow

```text
You: Track exercise three times a week
Bot: Added Exercise, three days a week. Reminder: 08:00.
     [Keep 08:00] [Change reminder] [No reminder] [Undo]

You: I read today
Bot: Read marked complete for today. Current streak: 4 days.
     [Undo]

You: How did I do this week?
Bot: Shows your completed days, targets, skips, and streaks.
```

The menu stays available: **Today · Add habit · My habits · Progress · Reminders**.
Tap **Add habit** for guided setup. Tell the bot the name, then choose its frequency.
Setup and clarification state survive a restart. Say **Cancel** or tap a menu item to leave a setup step.

To remove a habit, tap **My habits**, choose it, and tap **Remove habit**.
The habit disappears from daily use. Its history stays saved, and **Undo** restores it.
A removed habit has a **Restore habit** button in My habits.

Routine additions and explicit completions apply directly with Undo.
Undo belongs to that action. It cannot overwrite a newer change.
A completion that matches more than one habit asks you to choose before any write.

Common phrases work without AI, including the examples above when their habit names match.
Optional DeepSeek handles broader phrases, habit creation, progress queries, removal, and reminder changes.
Unclear input asks one short question and retains its context for your answer.
Provider failures cause no automatic change. The buttons remain available.
Old saved confirmation proposals still work. Older Undo buttons without an action identity expire safely.

## Daily check-in and habit reminders

After you start your separate bot, it sends a daily check-in at **08:00 Asia/Manila**.
Each new habit also starts with an 08:00 reminder.
When the daily check-in and habit reminders coincide, the bot sends one checklist.
Tap **Done** or **Skip**, or reply with a check-in.

- Tap **Reminders** to change the daily check-in time or turn it off.
- Tap **My habits**, choose a habit, and tap **Change reminder** to set its own time.
- Enter a time such as **8 AM**, **8 PM**, or **20:30**.
- Choose **No reminder** to disable a habit's reminder.

Habit reminders skip completed, skipped, and removed habits. They also stop after a weekly target is met.
The daily checklist can still show your overall progress when all habit reminders are suppressed.
A changed schedule cancels any pending notification from its older time.
The scheduler records each occurrence with its message. Restart does not create another occurrence.

The bot checks schedules inside its foreground process, about every 20 seconds while idle.
**Keep the bot process and its host available for reminders.** No automatic-start service is installed.
After a brief outage, a reminder can catch up for up to one hour.
Older and past-day notifications expire. The bot does not send a burst of missed reminders.
A schedule first set after its time begins the next day.
Telegram reply uncertainty can still duplicate a delivered message after a crash; occurrence creation remains deduplicated.

## Daily streak report

At **11 PM Asia/Manila**, the bot sends a daily streak report.
It shows each active habit's current daily or weekly streak, today's complete/skip/open state, and weekly target progress.
The report reads the same local logs as the progress views. It needs no AI call and changes no habit data.
A habit without today's log is not declared missed before local midnight.

Say **Show my streaks** to see the report now.
Tap **Reminders** to change the report time or turn it off.
You can also say **report at 11 PM**. Report settings stay separate from the morning reminder.

The report uses the existing durable outbox and one occurrence per local date.
A retry uses the latest logs. A restart does not create another report occurrence.
Changed or disabled schedules cancel queued reports. Old and past-day reports expire.
A report schedule first activated after its time begins the next day.
If the report shares a time with a reminder, one message contains the report and relevant check-in buttons.

## Optional command shortcuts

| Command | Result |
| --- | --- |
| `/add Read` or `/add Read \| daily` | Create a daily habit. |
| `/add Exercise \| weekly 3` | Create a weekly target of three separate days. |
| `/today` | Show active habits and dated Done / Undo buttons. |
| `/done Read` | Record completion for the message's local date. |
| `/skip Read` | Record an explicit skip. A skip does not count as complete. |
| `/undo Read` | Remove that day's check-in. |
| `/done Read \| yesterday` | Record a prior day relative to the message date. |
| `/done Read \| 2026-10-18` | Use an explicit date. |
| `/week` | Show this week's progress and streaks. |
| `/history Read` | Show the last 14 logged days, including skips. |
| `/habits` | List active and archived habits. |
| `/archive Read` | Hide a habit while its history remains intact. |
| `/resume Read` | Restore an archived habit. |
| `/screen 2h 15m` or `/screen 135` | Record a manual screen-time total. |
| `/screen` | Show the manual total for today. |
| `/status` | Show pending input and reply counts. |
| `/help` | Show command examples. |

Use exact habit names. Case and extra spaces do not matter.
Habit names can have up to 60 characters. This personal version supports up to 20 habits, including archived habits.
Commands remain available as shortcuts. The menu and normal chat provide the main flow.

## Date and streak rules

Each habit has at most one check-in per local calendar date.
A repeated Done tap keeps that date complete. It never toggles the habit off.
New Undo buttons restore their own action only. A newer state blocks an older Undo.
Done and Skip replace the selected day's prior state. Undo removes it.
Buttons always use the date printed on their original message.
Tap **Today** for new buttons after midnight.

Future dates and dates before habit creation are rejected.
A delayed message uses its original Telegram send date for its default log date.
Daily streaks count consecutive completed dates. Yesterday's streak stays current until today is missed.
Weekly streaks count consecutive weeks that meet the target. A week starts on Monday.
An incomplete current week does not erase the prior week's streak.
Daily weekly summaries count only elapsed dates since creation.
A partial first week's target cannot exceed its available calendar days.

Archive hides the habit. It does not pause calendar time or preserve a streak across missed periods.
Resume restores the same habit and history. The app does not delete histories through chat.

## Screen time on Android

**A Telegram bot cannot directly read Android screen time.**
Automatic data needs an Android helper with Usage Access permission.
Android's `UsageStatsManager` exposes usage data after permission through the device's Settings app.
This app has no Android helper, device permission, public intake endpoint, or automatic screen-time feed.

For now, you can type:

```text
screen time: 2 hours
/screen 2h 15m
/screen 135 | yesterday
```

Every stored total is marked **manual**. A new total replaces that day's old total instead of adding to it.
Valid daily totals range from zero to 1440 minutes.
A device integration needs a separate design for permission, app-usage versus display-on totals, delivery, and private credentials.
Keep the bot token on the bot host if a future helper sends data through a separate authenticated endpoint.

## Privacy and reliability

Only the configured Telegram user in a private chat can submit messages or button actions.
Groups, edited messages, images, voice input, and other users do not enter the queue.
Telegram updates are recorded locally before their acknowledgement offset advances.
The SQLite database retains source text, habit history, proposals, and pending replies.
Keep the data directory private. New database files use mode `0600`.

Habit effects, guided conversation state, and their response commit in one transaction.
The additive local schema upgrade preserves old histories, pending replies, and saved proposals.
An interrupted transaction leaves the input pending without a partial habit change.
After restart, pending inputs resume. Failed replies retry without a new habit effect.
Telegram rate-limit delays persist across a restart.
A crash after Telegram accepts a reply but before the local delivery mark can duplicate that reply.
It does not duplicate the habit log.

The app has one process lock per data directory. Two pollers must not share a bot token or database.
Five consecutive poll failures stop the process. Restart it after you resolve the connection problem.
An outage can delay retries because there is no always-on service.
Telegram keeps undelivered updates for at most 24 hours.
The local database protects received messages; it cannot preserve messages Telegram never delivered.

## Recovery and backup

After a normal shutdown, start the app with `npm start`.
After a hard kill, use the verified stale-lock recovery command:

```bash
npm start -- --recover-lock
npm start
```

Recovery removes a lock only when its recorded process is dead on the same host.
An active or unknown owner blocks recovery. Do not delete its lock manually.
Keep `.env` available for the recovery command.

For backup, stop the bot and copy the complete private data directory, including SQLite sidecar files.
Keep its permissions and original copy. Restore to a separate directory before replacement.
Do not delete the database to solve an owner or timezone mismatch.
No automatic migration from Grimoire or Notion occurs.

## Proof and open acceptance

Run `npm test` for habit, chat, migration, scheduler, and synthetic provider tests.
The 61 checks include synthetic Telegram handlers for menu setup, an 8 AM notification, its Done button, and the 11 PM streak report.
Run `npm run demo` for the offline create → log → duplicate → restart → summary flow.
Both commands use synthetic IDs and isolated temporary data. They do not call Telegram or DeepSeek.

`code verified`: build and focused tests passed. An independent reader checked access, replay, dates, and confirmations.
`live path verified`: open until a new message reaches the real bot, the local record, and the Telegram reply.
`production outcome verified`: open until Adam accepts the workflow after real phone use.

The GitHub repository contains source code only. No cloud deployment or automatic-start service is installed.
The existing inbox bot and Grimoire remain intact.

Official references:

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Android UsageStatsManager](https://developer.android.com/reference/android/app/usage/UsageStatsManager)
- [DeepSeek JSON output](https://api-docs.deepseek.com/guides/json_mode/)
