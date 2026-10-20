import { dailyStreak, monday, weeklyStreak, weeklyTarget } from './dates.js';
import { Store, type Reply } from './store.js';

export function streakReport(store: Store, day: string): Reply {
  const habits=store.habits().filter(h=>h.created_day<=day);
  const lines=['Your daily streak report',day+' · '+store.getSetting('timezone'),''];
  let complete=0,skipped=0;
  const details:string[]=[];
  for(const h of habits) {
    const logs=store.logs(h.id).filter(l=>l.day<=day);
    const done=logs.filter(l=>l.status==='done').map(l=>l.day);
    const status=logs.find(l=>l.day===day)?.status;
    if(status==='done') complete++;
    if(status==='skipped') skipped++;
    const streak=h.cadence==='daily'?dailyStreak(done,day)+'-day streak':weeklyStreak(done,day,h.target,h.created_day)+'-week streak';
    details.push(h.name+' · '+streak+'\nToday: '+(status==='done'?'complete':status==='skipped'?'skipped':'not logged yet')+
      (h.cadence==='weekly'?' · This week: '+done.filter(d=>d>=monday(day)).length+'/'+weeklyTarget(h.target,h.created_day,monday(day))+' days':''));
  }
  if(!habits.length) lines.push('No active habits yet. Tap Add habit to start.');
  else lines.push('Today: '+complete+'/'+habits.length+' complete · '+skipped+' skipped · '+(habits.length-complete-skipped)+' open','',...details);
  if(habits.some(h=>h.cadence==='daily'&&!store.logs(h.id).some(l=>l.day===day&&l.status==='done'))) {
    lines.push('','Streaks can still include yesterday until today ends at local midnight.');
  }
  return {text:lines.join('\n'),menu:true};
}
