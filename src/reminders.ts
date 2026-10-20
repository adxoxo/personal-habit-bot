import { clockAt, dayAt, monday, weeklyTarget } from './dates.js';
import { Store, type Habit, type Input, type Notification, type Reply } from './store.js';
import { streakReport } from './reports.js';

const minutes = (time: string) => Number(time.slice(0,2))*60+Number(time.slice(3));

export function needsHabitReminder(store: Store,h: Habit,day: string): boolean {
  if(!h.active || h.created_day>day) return false;
  const logs=store.logs(h.id);
  if(logs.some(l=>l.day===day)) return false;
  return h.cadence!=='weekly'||logs.filter(l=>l.status==='done'&&l.day>=monday(day)&&l.day<=day).length<weeklyTarget(h.target,h.created_day,monday(day));
}

function reminderReply(store: Store,notification: Notification): Reply | undefined {
  if(notification.report) {
    const report=streakReport(store,notification.day);
    const checklist=notification.daily||notification.habitIds.length?reminderReply(store,{...notification,report:false}):undefined;
    return {...report,buttons:checklist?.buttons};
  }
  const habits=notification.daily?store.habits():notification.habitIds.flatMap(id=>{const h=store.habit(id);return h&&needsHabitReminder(store,h,notification.day)?[h]:[];});
  if(!notification.daily&&!habits.length) return undefined;
  const text=[notification.daily?'Good morning. Here is your habit check-in.':'A reminder for your habits.',notification.day,''];
  const buttons: NonNullable<Reply['buttons']>=[];
  for(const h of habits) {
    const status=store.logs(h.id).find(l=>l.day===notification.day)?.status;
    const needed=needsHabitReminder(store,h,notification.day);
    text.push(h.name+' · '+(status==='done'?'complete':status==='skipped'?'skipped':needed?'ready for today':'weekly target met'));
    if(needed) buttons.push([{text:'Done: '+h.name,callback_data:`h:done:${h.id}:${notification.day}`},{text:'Skip',callback_data:`h:skip:${h.id}:${notification.day}`}]);
  }
  if(!habits.length) text.push('You have no active habits yet. Tap Add habit whenever you are ready.');
  text.push('','Tap Done, or tell me when you finish.');
  return {text:text.join('\n'),buttons:buttons.length?buttons:undefined,menu:!buttons.length};
}

export function refreshNotification(store: Store,input: Input,now: number): Reply | undefined {
  const n=input.notification;
  if(!n||n.expiresAt<=now||n.day!==dayAt(new Date(now),store.getSetting('timezone')!)) return undefined;
  const enabledDaily=n.daily&&store.getSetting('daily_enabled')!=='false'&&n.dailyTime===(store.getSetting('daily_time')??'08:00')&&n.dailySetAt===(store.getSetting('daily_set_at')??store.getSetting('activated_at'));
  const enabledReport=Boolean(n.report)&&store.getSetting('report_enabled')!=='false'&&n.reportTime===(store.getSetting('report_time')??'23:00')&&n.reportSetAt===(store.getSetting('report_set_at')??store.getSetting('activated_at'));
  const ids=n.habitIds.filter(id=>{const h=store.habit(id),schedule=n.habits?.[id];return h?.active&&schedule&&h.reminder_time===schedule.time&&h.reminder_set_at===schedule.setAt&&needsHabitReminder(store,h,n.day);});
  return reminderReply(store,{...n,daily:enabledDaily,habitIds:ids,report:enabledReport});
}

export class ReminderScheduler {
  constructor(private store: Store,private timezone: string,private now:()=>Date=()=>new Date()) {}
  tick(): void {
    const instant=this.now(),day=dayAt(instant,this.timezone),clock=clockAt(instant,this.timezone);
    const chat=this.store.getSetting('chat_id'),activation=this.store.getSetting('activated_at');
    if(!chat||!activation||chat!==this.store.getSetting('owner')) return;
    this.store.transaction(()=>{
      // Feature activation is distinct from the older bot activation date.
      if(!this.store.getSetting('report_set_at')) this.store.setSetting('report_set_at',instant.toISOString());
      const dueKeys: string[]=[],habitIds: string[]=[];
      let daily=false,report=false,expiresAt=Infinity;
      const due=(key:string,time:string,setAt:string):boolean=>{
        if(this.store.occurred(key)||clock<time) return false;
        const late=minutes(clock)-minutes(time);
        const set=dayAt(new Date(setAt||activation),this.timezone);
        const setClock=clockAt(new Date(setAt||activation),this.timezone);
        if(late>=60||set>day||(set===day&&setClock>=time)) {this.store.markOccurrence(key);return false;}
        dueKeys.push(key);
        expiresAt=Math.min(expiresAt,instant.getTime()-instant.getTime()%60000+(60-late)*60000);
        return true;
      };
      if(this.store.getSetting('daily_enabled')!=='false') daily=due('daily:'+day,this.store.getSetting('daily_time')??'08:00',this.store.getSetting('daily_set_at')??activation);
      if(this.store.getSetting('report_enabled')!=='false') report=due('report:'+day,this.store.getSetting('report_time')??'23:00',this.store.getSetting('report_set_at')??activation);
      for(const h of this.store.habits()) {
        if(h.reminder_time&&due('habit:'+h.id+':'+day,h.reminder_time,h.reminder_set_at||activation)&&needsHabitReminder(this.store,h,day)) habitIds.push(h.id);
      }
      if(!dueKeys.length) return;
      const notification: Notification={day,habitIds,daily,expiresAt,
        dailyTime:this.store.getSetting('daily_time')??'08:00',dailySetAt:this.store.getSetting('daily_set_at')??activation,
        report,reportTime:this.store.getSetting('report_time')??'23:00',reportSetAt:this.store.getSetting('report_set_at')??activation,
        habits:Object.fromEntries(habitIds.map(id=>{const h=this.store.habit(id)!;return [id,{time:h.reminder_time!,setAt:h.reminder_set_at}];}))};
      const reply=reminderReply(this.store,notification);
      if(!reply) {for(const key of dueKeys)this.store.markOccurrence(key);return;}
      this.store.queueNotification(dueKeys,Number(chat),notification,reply,instant.toISOString());
    });
  }
}
