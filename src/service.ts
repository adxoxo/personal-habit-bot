import { z } from 'zod';
import { InputError, addDays, dailyStreak, dayAt, daysBetween, monday, resolveDay, weeklyStreak, weeklyTarget } from './dates.js';
import { Store, type Habit, type HabitEvent, type Input, type Receipt, type Reply } from './store.js';
import { interpretationSchema, type Interpreter, type Interpretation } from './ai.js';
import { Conversation } from './conversation.js';
import { streakReport } from './reports.js';

const eventSchema = z.array(z.object({
  habitId: z.string().regex(/^[0-9a-f]{12}$/), day: z.string(), status: z.enum(['done', 'skipped']),
}).strict()).min(1).max(5);

const HELP = 'Your personal habit tracker\n\nJust tell me what you need:\n“Track exercise three times a week”\n“I read today”\n“How did I do this week?”\n\nOr use Today, Add habit, My habits, Progress, and Reminders below.\n\nYour daily check-in and new habit reminders default to 8 AM in Asia/Manila. You can change those times in Reminders or My habits.';

export class HabitService {
  private chat: Conversation;
  constructor(readonly store: Store, readonly timezone: string, private interpreter?: Interpreter,
    private now: () => Date = () => new Date()) {
    this.chat = new Conversation(store,timezone,now,{today:()=>this.todayReply(),week:()=>this.weeklyReply(),
      report:()=>streakReport(store,this.today()),
      logs:(events,source)=>this.logEvents(events,source),history:h=>this.historyReply(h)});
  }

  private today(): string { return dayAt(this.now(), this.timezone); }
  private reference(input: Input): string { return dayAt(new Date(input.at), this.timezone); }
  private habit(name: string, includeArchived = false): Habit {
    const habit = this.store.findHabit(name);
    if (!habit) throw new InputError('No habit matches that exact name. Use /habits or /add Name | daily.');
    if (!habit.active && !includeArchived) throw new InputError('That habit is archived. Use /resume ' + habit.name + ' first.');
    return habit;
  }
  private streak(h: Habit): string {
    const dates = this.store.logs(h.id).filter(l => l.status === 'done').map(l => l.day);
    return h.cadence === 'daily' ? dailyStreak(dates, this.today()) + '-day streak' :
      weeklyStreak(dates, this.today(), h.target, h.created_day) + '-week streak';
  }
  private validateEvents(events: HabitEvent[]): void {
    const seen = new Set<string>();
    for (const e of events) {
      const h = this.store.habit(e.habitId);
      if (!h?.active) throw new InputError('One habit is missing or archived. Nothing was changed.');
      resolveDay(e.day, this.today(), this.today(), h.created_day);
      const key = e.habitId + ':' + e.day;
      if (seen.has(key)) throw new InputError('The proposal repeats a habit and date. Nothing was changed.');
      seen.add(key);
    }
  }
  private todayReply(day = this.today()): Reply {
    const habits = this.store.habits();
    if (!habits.length) return { text: 'No active habits yet. Tap Add habit, or say “Track exercise three times a week”.', menu:true };
    const lines = ['Your habits · ' + day + ' · ' + this.timezone, ''];
    const buttons: NonNullable<Reply['buttons']> = [];
    for (const h of habits) {
      const status = this.store.logs(h.id).find(l => l.day === day)?.status;
      lines.push((status === 'done' ? 'Done' : status === 'skipped' ? 'Skipped' : 'Open') + ' · ' + h.name + ' · ' + this.streak(h));
      buttons.push([
        { text: 'Done: ' + h.name, callback_data: `h:done:${h.id}:${day}` },
        { text: 'Skip', callback_data: `h:skip:${h.id}:${day}` },
      ]);
    }
    const minutes = this.store.screen(day);
    if (minutes !== undefined) lines.push('', 'Screen time (manual): ' + minutes + ' min.');
    lines.push('', 'Buttons apply to ' + day + '. Tap Today for a fresh checklist.');
    return { text: lines.join('\n'), buttons };
  }
  private weeklyReply(): Reply {
    const today = this.today(), start = monday(today), habits = this.store.habits();
    if (!habits.length) return this.todayReply();
    const lines = ['This week · ' + start + ' to ' + today, ''];
    for (const h of habits) {
      const logs = this.store.logs(h.id).filter(l => l.day >= start && l.day <= today);
      const done = logs.filter(l => l.status === 'done').length, skipped = logs.filter(l => l.status === 'skipped').length;
      const expected = h.cadence === 'daily' ? Math.max(0, daysBetween(h.created_day > start ? h.created_day : start, today) + 1) : weeklyTarget(h.target, h.created_day, start);
      lines.push(h.name + ': ' + done + '/' + expected + (h.cadence === 'daily' ? ' days so far' : ' weekly goal') + '; ' + skipped + ' skipped. ' + this.streak(h) + '.');
    }
    lines.push('', 'Daily progress starts on the habit creation date. A partial first week has an adjusted weekly goal.');
    return { text: lines.join('\n') };
  }
  private change(h: Habit, day: string, status: 'done' | 'skipped' | 'undo', source: string): Reply {
    if (!h.active) throw new InputError('That habit is archived. Resume it before a new check-in.');
    resolveDay(day, this.today(), this.today(), h.created_day);
    const previous = this.store.logs(h.id).find(l => l.day === day)?.status;
    if (status === 'undo') {
      this.store.undo(h.id, day);
      return { text: (previous ? 'Removed the check-in for ' : 'No check-in to remove for ') + h.name + ' on ' + day + '.\n' + this.streak(h) + '.' };
    }
    if(previous===status) return {text:h.name+' was already '+(status==='done'?'complete':'skipped')+' for '+day+'.\n'+this.streak(h)+'.'};
    return this.logEvents([{habitId:h.id,day,status}],source);
  }
  private logEvents(events: HabitEvent[], source: string): Reply {
    this.validateEvents(events);
    const snapshots=events.flatMap(e=>{
      const before=this.store.logs(e.habitId).find(l=>l.day===e.day);
      return before?.status===e.status?[]:[{habitId:e.habitId,day:e.day,before:before?{status:before.status,source_id:before.source_id}:undefined,after:{status:e.status,source_id:source}}];
    });
    for(const s of snapshots) this.store.log(s.habitId,s.day,s.after.status,source);
    const undo=snapshots.length?this.chat.undoLogs(snapshots):undefined;
    return {text:events.map(e=>this.store.habit(e.habitId)!.name+' marked '+(e.status==='done'?'complete':'skipped')+' for '+e.day+'.\n'+this.streak(this.store.habit(e.habitId)!)+'.').join('\n'),
      buttons:undo?[[{text:'Undo',callback_data:'u:'+undo}]]:undefined};
  }
  private historyReply(h: Habit): Reply {
    const logs=this.store.logs(h.id).filter(l=>l.day<=this.today()).slice(-14).reverse();
    return {text:h.name+' · last 14 logged days\n'+(logs.length?logs.map(l=>l.day+' · '+l.status).join('\n'):'No check-ins yet.')+'\n'+this.streak(h)+'.'};
  }
  private callback(input: Input): Reply {
    const chatReply=this.chat.respond(input); if(chatReply) return chatReply;
    const habit = input.text.match(/^h:(done|skip|undo):([a-f0-9]{12}):(\d{4}-\d{2}-\d{2})$/);
    if(habit?.[1]==='undo') throw new InputError('That older Undo has expired. Tap Today for current controls. Your latest check-in is safe.');
    if (habit) return this.change(this.habit(habit[2]!), habit[3]!, habit[1]==='skip'?'skipped':habit[1] as 'done' | 'undo', input.sourceId);
    const match = input.text.match(/^p:(confirm|cancel):([a-f0-9]{12})$/);
    if (!match) throw new InputError('That button is invalid. Use /today for a fresh check-in.');
    const proposal = this.store.proposal(match[2]!);
    if (!proposal) throw new InputError('That proposal no longer exists. Please send the check-in again.');
    if (proposal.state !== 'open') return { text: 'That proposal is already ' + proposal.state + '. No new changes.' };
    if (match[1] === 'cancel') { this.store.resolveProposal(proposal.id, 'canceled'); return { text: 'Canceled. Your habit history did not change.' }; }
    if (proposal.created_day !== this.today()) throw new InputError('That proposal has expired. Please send the check-in again.');
    const parsed = eventSchema.safeParse(JSON.parse(proposal.events));
    if (!parsed.success) throw new InputError('That proposal is invalid. Nothing was changed.');
    this.validateEvents(parsed.data);
    for (const e of parsed.data) this.store.log(e.habitId, e.day, e.status, input.sourceId);
    this.store.resolveProposal(proposal.id, 'confirmed');
    return { text: 'Confirmed.\n' + parsed.data.map(e => this.store.habit(e.habitId)!.name + ' · ' + e.day + ' · ' + e.status + ' · ' + this.streak(this.store.habit(e.habitId)!)).join('\n') };
  }
  private screen(argument: string, input: Input): Reply {
    const pieces = argument.split('|');
    if (pieces.length > 2) throw new InputError('Use /screen 2h 15m, optionally followed by | yesterday.');
    const value = pieces[0]!.trim().toLowerCase();
    const day = resolveDay(pieces[1], this.reference(input), this.today());
    if (!value) {
      const minutes = this.store.screen(day);
      return { text: minutes === undefined ? 'No manual screen time for ' + day + '. Use /screen 2h 15m.\nAutomatic Android access needs a separate companion app.' :
        'Screen time for ' + day + ': ' + minutes + ' min (manual).\nThis is a reported total, not automatic phone monitoring.' };
    }
    let minutes: number;
    if (/^\d+$/.test(value)) minutes = Number(value);
    else {
      const normalized = value.replace(/hours?/g, 'h').replace(/minutes?|mins?/g, 'm').replace(/\s+/g, '');
      const duration = normalized.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
      if (!duration || (!duration[1] && !duration[2])) throw new InputError('Use whole minutes or a duration, such as /screen 120 or /screen 2h 15m.');
      minutes = Number(duration[1] ?? 0) * 60 + Number(duration[2] ?? 0);
    }
    if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 1440) throw new InputError('A daily screen-time total must be between 0 and 1440 minutes.');
    this.store.saveScreen(day, minutes, input.sourceId);
    return { text: 'Screen time for ' + day + ': ' + minutes + ' min (manual).\nThis replaces the prior reported total for that day.' };
  }
  private command(input: Input): Reply | undefined {
    const text = input.text.trim();
    if (input.kind === 'callback') return this.callback(input);
    if (/^screen\s*time\s*:/i.test(text)) return this.screen(text.replace(/^screen\s*time\s*:/i, ''), input);
    const parsed = text.match(/^(?:\/([a-z]+)(?:@\w+)?|((?:done|skip|undo)))\s*([\s\S]*)$/i);
    if (!parsed) return undefined;
    const command = (parsed[1] ?? parsed[2])!.toLowerCase(), argument = parsed[3]!.trim();
    if (command === 'start' || command === 'help') {this.store.setConversation(undefined);return { text: HELP, menu:true };}
    if (command === 'today') return this.todayReply();
    if (command === 'week') return this.weeklyReply();
    if (command === 'screen') return this.screen(argument, input);
    if (command === 'status') { const state = this.store.status(); return { text: 'Local habit data is available. Pending input: ' + Math.max(0, state.pending - 1) + '. Replies awaiting delivery: ' + state.replies + '.\nTimezone: ' + this.timezone + '. AI: ' + (this.interpreter ? 'configured' : 'not configured') + '.' }; }
    if (command === 'habits') {
      const habits = this.store.habits(true);
      return { text: habits.length ? habits.map(h => h.name + ' · ' + (h.cadence === 'daily' ? 'daily' : h.target + '/week') + (h.active ? '' : ' · archived')).join('\n') : 'No habits yet. Use /add Read | daily.' };
    }
    if (command === 'add') {
      const parts = argument.split('|').map(p => p.trim());
      const schedule = (parts[1] ?? 'daily').toLowerCase();
      const weekly = schedule.match(/^weekly\s+([1-7])$/);
      if (parts.length > 2 || (schedule !== 'daily' && !weekly)) throw new InputError('Use /add Read | daily or /add Exercise | weekly 3.');
      return this.chat.add(parts[0]??'',weekly?'weekly':'daily',weekly?Number(weekly[1]):7,input);
    }
    if (['done', 'skip', 'undo'].includes(command)) {
      const parts = argument.split('|');
      if (parts.length > 2) throw new InputError('Use /done Habit name | yesterday, or omit the date for today.');
      const h = this.habit(parts[0]!);
      const day = resolveDay(parts[1], this.reference(input), this.today(), h.created_day);
      return this.change(h, day, command === 'skip' ? 'skipped' : command as 'done' | 'undo', input.sourceId);
    }
    if (command === 'archive' || command === 'resume') {
      const h = this.habit(argument, true);return this.chat.archive(h,command==='resume');
    }
    if (command === 'history') {
      return this.historyReply(this.habit(argument,true));
    }
    return { text: 'Unknown command. Use /help, /today, or /week.' };
  }
  async process(receipt: Receipt): Promise<Reply> {
    const input = JSON.parse(receipt.payload) as Input;
    if (receipt.response) return JSON.parse(receipt.response) as Reply;
    // No async work occurs inside the transaction. Unsupported prose is interpreted first.
    try {
      let interpretation=this.chat.localIntent(input),aiFailed=false;
      const recognized=input.kind==='callback'||/^\//.test(input.text.trim())||/^(done|skip|undo)\s+/i.test(input.text.trim())||/^screen\s*time\s*:/i.test(input.text.trim())||this.chat.handles(input)||Boolean(interpretation);
      if(!recognized&&this.interpreter) {
        try { interpretation=interpretationSchema.parse(await this.interpreter.interpret(this.chat.aiText(input),this.store.habits(),this.reference(input))); }
        catch { aiFailed=true; }
      }
      return this.store.commitReply(receipt.id, () => {
        const commandReply = this.command(input);
        if (commandReply) return commandReply;
        const chatReply=this.chat.respond(input,interpretation);if(chatReply) return chatReply;
        if (interpretation?.kind === 'today') return this.todayReply();
        if (interpretation?.kind === 'week') return this.weeklyReply();
        if (interpretation?.kind === 'log') {
          const events = eventSchema.safeParse(interpretation.events);
          if (!events.success) throw new InputError('The suggested check-in is invalid. Nothing was changed. Use /today.');
          this.validateEvents(events.data);
          return this.logEvents(events.data,input.sourceId);
        }
        return { text: (aiFailed ? 'AI is unavailable. No habit was changed. ' : 'I could not identify a clear check-in. ') + 'Tap Today to check in, or Add habit to create one.',menu:true };
      });
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      return this.store.commitReply(receipt.id, () => ({ text: error.message }));
    }
  }
  async drain(): Promise<void> { for (const receipt of this.store.pending()) await this.process(receipt); }
}
