import { z } from 'zod';
import { InputError, dayAt, parseTime, resolveDay } from './dates.js';
import { Store, id, normalizeName, type Habit, type HabitEvent, type Input, type Reply } from './store.js';
import type { Interpretation } from './ai.js';

type Draft = { kind: 'name' | 'cadence' | 'target' | 'habit_time' | 'daily_time' | 'report_time' | 'clarify' | 'pick_log'; name?: string; habitId?: string; original?: string; question?: string; draftId?: string; candidates?: HabitEvent[] };
export type ChatIntent = Interpretation | {kind:'choose_log';events:HabitEvent[]};
type Snapshot = { habitId: string; day: string; before?: { status: 'done' | 'skipped'; source_id: string }; after: { status: 'done' | 'skipped'; source_id: string } };
const undoSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('logs'), snapshots: z.array(z.object({ habitId: z.string(), day: z.string(),
    before: z.object({ status: z.enum(['done','skipped']), source_id: z.string() }).optional(),
    after: z.object({ status: z.enum(['done','skipped']), source_id: z.string() }),
  })).min(1).max(5) }),
  z.object({ kind: z.literal('active'), habitId: z.string(), before: z.boolean(), revision: z.number().int(), create: z.boolean() }),
]);

export const MENU = [['Today', 'Add habit'], ['My habits', 'Progress'], ['Reminders']];
const menuNames = new Set(MENU.flat().map(s => s.toLowerCase()));
const title = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Conversation {
  constructor(private store: Store, private timezone: string, private now: () => Date,
    private actions: { today: () => Reply; week: () => Reply; report:()=>Reply; logs: (events: HabitEvent[], source: string) => Reply; history: (h: Habit) => Reply }) {}
  private today(): string { return dayAt(this.now(), this.timezone); }
  state(): Draft | undefined { return this.store.conversation() as Draft | undefined; }
  private remember(state?: Draft): void { this.store.setConversation(state); }
  handles(input: Input): boolean {
    return input.kind === 'callback' ? /^(m:|g:|u:)/.test(input.text) :
      menuNames.has(input.text.trim().toLowerCase()) || /^cancel$/i.test(input.text.trim()) || Boolean(this.state() && this.state()!.kind !== 'clarify');
  }
  aiText(input: Input): string {
    const state = this.state();
    return state?.kind === 'clarify' ? JSON.stringify({ original: state.original, question: state.question, answer: input.text }) : input.text;
  }
  localIntent(input: Input): ChatIntent | undefined {
    if (input.kind !== 'text' || this.handles(input) || this.state()?.kind === 'clarify') return undefined;
    const text = input.text.trim().replace(/[.!?]+$/, '');
    if(/^(?:show (?:me )?(?:my )?streaks|(?:daily |streak )?report|show (?:my )?(?:daily |streak )report)$/i.test(text)) return {kind:'report'};
    const reportTime=text.match(/^(?:send (?:my |the )?)?(?:daily |streak )?report (?:at|time)\s+(.+)$/i);
    if(reportTime) {const time=parseTime(reportTime[1]!);if(time)return {kind:'report_time',time};}
    if (/^(?:how (?:did|am) i do(?:ing)? this week|show (?:my )?(?:weekly )?progress|this week)$/i.test(text)) return {kind:'week'};
    if (/^(?:show (?:my )?habits|my habits)$/i.test(text)) return {kind:'habits'};
    const daily = text.match(/^(?:track|i want to|start tracking)\s+(.+?)\s+(?:daily|every day)$/i);
    if (daily) return {kind:'create',name:title(daily[1]!),cadence:'daily',target:7};
    const weekly = text.match(/^(?:track|i want to|start tracking)\s+(.+?)\s+(one|two|three|four|five|six|seven|[1-7])\s+times?\s+(?:a|per|each) week$/i);
    if (weekly) return {kind:'create',name:title(weekly[1]!),cadence:'weekly',target: Number(weekly[2]) || ['one','two','three','four','five','six','seven'].indexOf(weekly[2]!.toLowerCase())+1};
    const remove = text.match(/^(?:remove|stop tracking|archive)\s+(.+)$/i);
    if (remove) { const h=this.store.findHabit(remove[1]!); if(h?.active) return {kind:'archive',habitId:h.id}; }
    const candidates: HabitEvent[]=[];
    for (const h of this.store.habits()) {
      const match = text.match(new RegExp('^i (?:finished |completed |did )?'+escape(h.name)+'(?: for \\d+ (?:minutes?|hours?))?(?: (today|yesterday))?$','i'));
      if (match) candidates.push({habitId:h.id,day:resolveDay(match[1],dayAt(new Date(input.at),this.timezone),this.today(),h.created_day),status:'done'});
    }
    if(candidates.length===1) return {kind:'log',events:candidates};
    if(candidates.length>1) return {kind:'choose_log',events:candidates};
    return undefined;
  }
  undoLogs(snapshots: Snapshot[]): string {
    return this.store.saveUndo({kind:'logs',snapshots});
  }
  add(name: string, cadence: 'daily'|'weekly', target: number, input: Input): Reply {
    const h=this.store.addHabit(name,cadence,target,dayAt(new Date(input.at),this.timezone));
    this.store.setReminder(h.id,this.store.getSetting('default_habit_time') ?? '08:00',this.now().toISOString());
    const saved=this.store.habit(h.id)!;
    const undo=this.store.saveUndo({kind:'active',habitId:h.id,before:false,revision:saved.revision,create:true});
    this.remember();
    return {text:'Added '+h.name+' · '+(cadence==='daily'?'every day':target+' days a week')+'.\nReminder: '+saved.reminder_time+' · '+this.timezone+'. You can change it below.',
      buttons:[[{text:'Keep '+saved.reminder_time,callback_data:'m:keep:'+h.id},{text:'Change reminder',callback_data:'m:time:'+h.id}],
        [{text:'No reminder',callback_data:'m:off:'+h.id},{text:'Undo',callback_data:'u:'+undo}]]};
  }
  archive(h: Habit, active: boolean): Reply {
    if(Boolean(h.active)===active) return {text:h.name+(active?' is already active.':' is already removed.')};
    this.store.setActive(h.id,active);
    const undo=this.store.saveUndo({kind:'active',habitId:h.id,before:Boolean(h.active),revision:this.store.habit(h.id)!.revision,create:false});
    return {text:h.name+(active?' restored.':' removed from your habits. Your history is saved.'),buttons:[[{text:'Undo',callback_data:'u:'+undo}]]};
  }
  private undo(actionId: string): Reply {
    const saved=this.store.undoAction(actionId);
    if(!saved || saved.used) return {text:'That Undo was already used or is unavailable. Your latest changes are safe.'};
    const action=undoSchema.parse(JSON.parse(saved.action));
    if(action.kind==='logs') {
      for(const s of action.snapshots) {
        const current=this.store.logs(s.habitId).find(l=>l.day===s.day);
        if(current?.status!==s.after.status || current.source_id!==s.after.source_id) throw new InputError('That habit has a newer change. This Undo will not overwrite it.');
      }
      for(const s of action.snapshots) {
        if(s.before) this.store.log(s.habitId,s.day,s.before.status,s.before.source_id);
        else this.store.undo(s.habitId,s.day);
      }
    } else {
      const h=this.store.habit(action.habitId);
      if(!h || h.revision!==action.revision || (action.create && this.store.logs(h.id).length)) throw new InputError('That habit has newer changes. Use My habits to manage it.');
      this.store.setActive(h.id,action.before);
    }
    this.store.useUndo(actionId);
    return {text:'Undone. Your previous habit state is restored.',menu:true};
  }
  habits(): Reply {
    const habits=this.store.habits(true);
    return {text:habits.length?'Choose a habit to view its history, change its reminder, or remove it.':'No habits yet. Tap Add habit to start.',
      buttons:habits.length?habits.map(h=>[{text:h.name+(h.active?'':' (removed)'),callback_data:'m:open:'+h.id}]):undefined,menu:!habits.length};
  }
  reminders(): Reply {
    const time=this.store.getSetting('daily_time') ?? '08:00', enabled=this.store.getSetting('daily_enabled')!=='false';
    const reportTime=this.store.getSetting('report_time')??'23:00',reportEnabled=this.store.getSetting('report_enabled')!=='false';
    this.remember();
    return {text:'Daily check-in: '+(enabled?time:'off')+' · '+this.timezone+'.\nDaily streak report: '+(reportEnabled?reportTime:'off')+' · '+this.timezone+'.\nEach habit also has its own reminder time. Tap My habits to change one.\nIf schedules are due together, you get one message.',
      buttons:[[{text:'Change daily time',callback_data:'g:daily:time'},{text:enabled?'Turn daily off':'Turn daily on',callback_data:enabled?'g:daily:off':'g:daily:on'}],
        [{text:'Change report time',callback_data:'g:report:time'},{text:reportEnabled?'Turn report off':'Turn report on',callback_data:reportEnabled?'g:report:off':'g:report:on'}]]};
  }
  setDailyTime(time: string | null): Reply {
    this.store.setSetting('daily_enabled',String(time!==null));
    if(time) this.store.setSetting('daily_time',time);
    this.store.setSetting('daily_set_at',this.now().toISOString()); this.remember();
    return {text:time?'Daily check-in set to '+time+' · '+this.timezone+'.':'Daily check-in turned off. Habit reminders keep their own settings.',menu:true};
  }
  setReportTime(time:string|null):Reply {
    this.store.setSetting('report_enabled',String(time!==null));
    if(time)this.store.setSetting('report_time',time);
    this.store.setSetting('report_set_at',this.now().toISOString());this.remember();
    return {text:time?'Daily streak report set to '+time+' · '+this.timezone+'.':'Daily streak report turned off. Your habit reminders keep their own settings.',menu:true};
  }
  private setHabitTime(habitId: string,time: string|null): Reply {
    const h=this.store.habit(habitId);
    if(!h?.active) throw new InputError('That habit is removed. Restore it in My habits first.');
    this.store.setReminder(h.id,time,this.now().toISOString()); this.remember();
    return {text:h.name+': '+(time?'reminder set to '+time+' · '+this.timezone+'.':'reminder turned off.'),menu:true};
  }
  private callback(input: Input): Reply | undefined {
    const undo=input.text.match(/^u:([a-f0-9]{12})$/); if(undo) return this.undo(undo[1]!);
    if(input.text==='g:daily:time') {this.remember({kind:'daily_time'});return {text:'What time should the daily check-in arrive? For example, 8 AM or 20:30.\nTimes use '+this.timezone+'. Say Cancel to leave this unchanged.'};}
    if(input.text==='g:daily:off') return this.setDailyTime(null);
    if(input.text==='g:daily:on') return this.setDailyTime(this.store.getSetting('daily_time')??'08:00');
    if(input.text==='g:report:time') {this.remember({kind:'report_time'});return {text:'What time should your daily streak report arrive? For example, 11 PM.\nTimes use '+this.timezone+'. Say Cancel to keep it.'};}
    if(input.text==='g:report:off')return this.setReportTime(null);
    if(input.text==='g:report:on')return this.setReportTime(this.store.getSetting('report_time')??'23:00');
    const menu=input.text.match(/^m:(open|remove|resume|time|off|keep|history):([a-f0-9]{12})$/);
    if(menu) {
      const h=this.store.habit(menu[2]!); if(!h) throw new InputError('That habit is unavailable. Open My habits for the latest list.');
      if(menu[1]==='remove') return this.archive(h,false);
      if(menu[1]==='resume') return this.archive(h,true);
      if(menu[1]==='history') return this.actions.history(h);
      if(menu[1]==='off') return this.setHabitTime(h.id,null);
      if(menu[1]==='keep') return {text:h.name+' reminder stays at '+(h.reminder_time??'off')+'.',menu:true};
      if(menu[1]==='time') {this.remember({kind:'habit_time',habitId:h.id});return {text:'What time should I remind you about '+h.name+'? For example, 8 AM or 20:30.\nSay No reminder to turn it off, or Cancel to keep it.'};}
      return {text:h.name+' · '+(h.cadence==='daily'?'daily':h.target+' days a week')+'\nReminder: '+(h.reminder_time??'off')+' · '+this.timezone,
        buttons:h.active?[[{text:'Change reminder',callback_data:'m:time:'+h.id},{text:'History',callback_data:'m:history:'+h.id}],[{text:'Remove habit',callback_data:'m:remove:'+h.id}]]:
          [[{text:'Restore habit',callback_data:'m:resume:'+h.id},{text:'History',callback_data:'m:history:'+h.id}]]};
    }
    const cadence=input.text.match(/^g:(daily|weekly):([a-f0-9]{12})$/);
    if(cadence) {
      const state=this.state(); if(!state?.name || state.kind!=='cadence'||state.draftId!==cadence[2]) throw new InputError('That setup step has expired. Tap Add habit to start again.');
      if(cadence[1]==='daily') return this.add(state.name,'daily',7,input);
      this.remember({...state,kind:'target'});return {text:'How many days each week?',buttons:[[2,3,4,5,7].map(n=>({text:String(n),callback_data:'g:target:'+n+':'+state.draftId}))]};
    }
    const target=input.text.match(/^g:target:([1-7]):([a-f0-9]{12})$/);
    if(target) {const state=this.state();if(state?.kind!=='target'||!state.name||state.draftId!==target[2]) throw new InputError('That setup step has expired. Tap Add habit to start again.');return this.add(state.name,'weekly',Number(target[1]),input);}
    const pick=input.text.match(/^g:pick:([a-f0-9]{12}):([a-f0-9]{12})$/);
    if(pick) {
      const state=this.state(),event=state?.candidates?.find(e=>e.habitId===pick[1]);
      if(state?.kind!=='pick_log'||state.draftId!==pick[2]||!event) throw new InputError('That choice has expired. Tell me which habit you completed.');
      const reply=this.actions.logs([event],input.sourceId);this.remember();return reply;
    }
    return undefined;
  }
  respond(input: Input,intent?: ChatIntent): Reply | undefined {
    if(input.kind==='callback') return this.callback(input);
    const text=input.text.trim(), key=text.toLowerCase();
    if(menuNames.has(key)||key==='cancel') {
      this.remember();
      if(key==='today') return this.actions.today();
      if(key==='progress') return this.actions.week();
      if(key==='my habits') return this.habits();
      if(key==='reminders') return this.reminders();
      if(key==='cancel') return {text:'Canceled. Tap a menu button whenever you need it.',menu:true};
      this.remember({kind:'name',draftId:id()});return {text:'What habit would you like to track? For example, Read for 20 minutes.\nSay Cancel at any step.'};
    }
    const state=this.state();
    if(state && state.kind!=='clarify') {
      if(state.kind==='pick_log') {
        const event=state.candidates?.find(e=>normalizeName(this.store.habit(e.habitId)?.name??'')===normalizeName(text));
        if(!event) return {text:'Choose one of those habits, or say Cancel.'};
        const reply=this.actions.logs([event],input.sourceId);this.remember();return reply;
      }
      if(state.kind==='name') {
        if(!text || text.length>60 || /[|\x00-\x1f]/.test(text)) throw new InputError('Use a short habit name, up to 60 characters.');
        if(this.store.findHabit(text)) throw new InputError('That habit already exists. Open My habits to manage or restore it.');
        this.remember({kind:'cadence',name:title(text),draftId:state.draftId});
        return {text:'How often would you like to do '+text+'?',buttons:[[{text:'Every day',callback_data:'g:daily:'+state.draftId},{text:'A few days a week',callback_data:'g:weekly:'+state.draftId}]]};
      }
      if(state.kind==='cadence') {
        if(/^(daily|every day)$/i.test(text)) return this.add(state.name!,'daily',7,input);
        const target=text.match(/^(?:weekly\s+)?([1-7])(?:\s+(?:days|times)(?:\s+a week)?)?$/i);
        if(target) return this.add(state.name!,'weekly',Number(target[1]),input);
        return {text:'Tap Every day or A few days a week, or tell me a number from 1 to 7.'};
      }
      if(state.kind==='target') {if(!/^[1-7]$/.test(text)) throw new InputError('How many days each week? Choose a number from 1 to 7.');return this.add(state.name!,'weekly',Number(text),input);}
      const time=parseTime(text), off=/^(off|none|no reminder)$/i.test(text);
      if(!time&&!off) throw new InputError('What time works? Use 8 AM, 20:30, or No reminder.');
      if(state.kind==='daily_time') return this.setDailyTime(off?null:time!);
      if(state.kind==='report_time')return this.setReportTime(off?null:time!);
      return this.setHabitTime(state.habitId!,off?null:time!);
    }
    if(intent?.kind==='create') return this.add(intent.name,intent.cadence,intent.cadence==='daily'?7:intent.target,input);
    if(intent?.kind==='choose_log') {
      const draftId=id();this.remember({kind:'pick_log',candidates:intent.events,draftId});
      return {text:'Which habit did you complete?',buttons:intent.events.map(e=>[{text:this.store.habit(e.habitId)!.name,callback_data:'g:pick:'+e.habitId+':'+draftId}])};
    }
    if(intent?.kind==='habits') {this.remember();return this.habits();}
    if(intent?.kind==='archive') {const h=this.store.habit(intent.habitId);if(!h) throw new InputError('Which habit do you want to remove? Open My habits to choose.');this.remember();return this.archive(h,false);}
    if(intent?.kind==='reminder') return intent.habitId?this.setHabitTime(intent.habitId,intent.time):this.setDailyTime(intent.time);
    if(intent?.kind==='report_time')return this.setReportTime(intent.time);
    if(intent?.kind==='report'){this.remember();return this.actions.report();}
    if(intent?.kind==='clarify') {this.remember({kind:'clarify',original:this.aiText(input).slice(0,3000),question:intent.question});return {text:intent.question};}
    if(intent && intent.kind!=='unknown') this.remember();
    return undefined;
  }
}
