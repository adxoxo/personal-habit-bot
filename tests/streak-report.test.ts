import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Bot} from 'grammy';
import type {UserFromGetMe} from 'grammy/types';
import {Store,type Input} from '../src/store.js';
import {HabitService} from '../src/service.js';
import {ReminderScheduler} from '../src/reminders.js';
import {flushOutbox,installHandlers} from '../src/telegram.js';
import {streakReport} from '../src/reports.js';

class Fixture {
  directory=mkdtempSync(join(tmpdir(),'habit-streak-report-'));
  path=join(this.directory,'habits.sqlite');
  now=new Date('2026-10-17T23:00:00Z'); // October 18, 07:00 Manila.
  store=new Store(this.path,'123','Asia/Manila');
  service:HabitService;
  scheduler:ReminderScheduler;
  next=0;
  constructor(t:TestContext) {
    this.service=new HabitService(this.store,'Asia/Manila',undefined,()=>this.now);
    this.scheduler=new ReminderScheduler(this.store,'Asia/Manila',()=>this.now);
    this.store.setSetting('chat_id','123');this.store.setSetting('activated_at',this.now.toISOString());
    this.scheduler.tick(); // Activate the feature before its due time.
    t.after(()=>{this.store.close();rmSync(this.directory,{recursive:true,force:true});});
  }
  async say(text:string,kind:'text'|'callback'='text') {
    const n=++this.next;
    return this.service.process(this.store.enqueue({updateId:n,sourceId:kind+':'+n,chatId:123,userId:123,kind,text,at:this.now.toISOString()}));
  }
  reopen(){this.store.close();this.store=new Store(this.path,'123','Asia/Manila');this.service=new HabitService(this.store,'Asia/Manila',undefined,()=>this.now);this.scheduler=new ReminderScheduler(this.store,'Asia/Manila',()=>this.now);}
  reports(){return this.store.outbox(this.now.getTime()).filter(r=>(JSON.parse(r.payload) as Input).notification?.report);}
}

test('report matches daily and weekly streaks, today states, and weekly goals without any write',t=>{
  const f=new Fixture(t),s=f.store;
  const read=s.addHabit('Read','daily',7,'2026-10-15');
  const exercise=s.addHabit('Exercise','weekly',3,'2026-10-05');
  const walk=s.addHabit('Walk','daily',7,'2026-10-15');
  const write=s.addHabit('Write','daily',7,'2026-10-15');
  const archived=s.addHabit('Removed habit','daily',7,'2026-10-15');s.setActive(archived.id,false);
  for(const day of ['2026-10-16','2026-10-17','2026-10-18'])s.log(read.id,day,'done','synthetic-read');
  for(const day of ['2026-10-05','2026-10-07','2026-10-09','2026-10-12','2026-10-14','2026-10-18'])s.log(exercise.id,day,'done','synthetic-exercise');
  s.log(walk.id,'2026-10-17','done','synthetic-walk');s.log(walk.id,'2026-10-18','skipped','synthetic-skip');
  s.log(write.id,'2026-10-17','done','synthetic-write');
  const before=s.db.prepare('SELECT total_changes() AS n').get()!.n;
  const report=streakReport(s,'2026-10-18');
  assert.match(report.text,/Read · 3-day streak\nToday: complete/);
  assert.match(report.text,/Exercise · 2-week streak\nToday: complete · This week: 3\/3 days/);
  assert.match(report.text,/Walk · 1-day streak\nToday: skipped/);
  assert.match(report.text,/Write · 1-day streak\nToday: not logged yet/);
  assert.match(report.text,/Today: 2\/4 complete · 1 skipped · 1 open/);
  assert.doesNotMatch(report.text,/Removed habit/);
  assert.equal(s.db.prepare('SELECT total_changes() AS n').get()!.n,before);
});

test('report handles empty habits and maximum long-name content within Telegram limits',t=>{
  const f=new Fixture(t);assert.match(streakReport(f.store,'2026-10-18').text,/No active habits/);
  for(let i=0;i<20;i++)f.store.addHabit(String(i).padStart(2,'0')+'x'.repeat(58),'weekly',7,'2026-10-18');
  assert.ok(streakReport(f.store,'2026-10-18').text.length<=3900);
});

test('23:00 Manila queues exactly one report across repeated ticks and restart',async t=>{
  const f=new Fixture(t);await f.say('Track Read every day');
  f.now=new Date('2026-10-18T14:59:00Z');f.scheduler.tick();assert.equal(f.reports().length,0);
  f.now=new Date('2026-10-18T15:00:00Z');f.scheduler.tick();f.scheduler.tick();assert.equal(f.reports().length,1);
  assert.equal((JSON.parse(f.reports()[0]!.payload) as Input).notification!.day,'2026-10-18');
  f.reopen();f.scheduler.tick();assert.equal(f.reports().length,1);assert.equal(f.store.occurred('report:2026-10-18'),true);
});

test('a newly installed report schedule after 23:00 starts tomorrow and preserves its activation timestamp',t=>{
  const f=new Fixture(t);f.store.db.prepare("DELETE FROM meta WHERE key='report_set_at'").run();
  f.now=new Date('2026-10-18T15:30:00Z');f.scheduler.tick();assert.equal(f.reports().length,0);
  const activation=f.store.getSetting('report_set_at');assert.equal(activation,f.now.toISOString());
  f.reopen();f.now=new Date('2026-10-19T15:00:00Z');f.scheduler.tick();assert.equal(f.reports().length,1);
  assert.equal(f.store.getSetting('report_set_at'),activation);
});

test('retry after restart renders latest logs without another report occurrence',async t=>{
  const f=new Fixture(t);await f.say('Track Read every day');
  f.now=new Date('2026-10-18T15:00:00Z');f.scheduler.tick();
  await flushOutbox(f.store,{send:async()=>{throw new Error('synthetic offline');}},f.now.getTime());
  f.reopen();f.now=new Date('2026-10-18T15:05:00Z');await f.say('I read today');f.scheduler.tick();
  const sent:string[]=[];await flushOutbox(f.store,{send:async(_chat,reply)=>{sent.push(reply.text);}},f.now.getTime());
  const reports=sent.filter(text=>text.startsWith('Your daily streak report'));
  assert.equal(reports.length,1);assert.match(reports[0]!,/Read · 1-day streak\nToday: complete/);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM reminder_occurrence WHERE key='report:2026-10-18'").get()!.n,1);
});

test('disabled, rescheduled, and past-day reports are suppressed before send',async t=>{
  for(const scenario of ['disabled','rescheduled','past-day']) {
    const f=new Fixture(t);f.now=new Date('2026-10-18T15:00:00Z');f.scheduler.tick();assert.equal(f.reports().length,1);
    f.now=new Date('2026-10-18T15:05:00Z');
    if(scenario==='disabled')f.store.setSetting('report_enabled','false');
    if(scenario==='rescheduled'){f.store.setSetting('report_time','23:30');f.store.setSetting('report_set_at',f.now.toISOString());}
    if(scenario==='past-day')f.now=new Date('2026-10-18T16:00:00Z');
    const sent:string[]=[];await flushOutbox(f.store,{send:async(_chat,reply)=>{sent.push(reply.text);}},f.now.getTime());
    assert.equal(sent.some(text=>text.startsWith('Your daily streak report')),false,scenario);
  }
});

test('Reminders controls change the report without changing the morning reminder',async t=>{
  const f=new Fixture(t),settings=await f.say('Reminders');
  const change=settings.buttons!.flat().find(b=>b.callback_data==='g:report:time')!;
  await f.say(change.callback_data,'callback');await f.say('11 PM');f.reopen();
  assert.equal(f.store.getSetting('report_time'),'23:00');assert.equal(f.store.getSetting('daily_time')??'08:00','08:00');
  await f.say('g:report:off','callback');assert.equal(f.store.getSetting('report_enabled'),'false');
  await f.say('g:report:on','callback');assert.equal(f.store.getSetting('report_enabled'),'true');
  assert.equal(f.store.getSetting('daily_enabled')??'true','true');
});

test('normal chat can show streaks and change the report time without AI or reminder changes',async t=>{
  const f=new Fixture(t);await f.say('Track Read every day');
  assert.match((await f.say('Show my streaks')).text,/Read · 0-day streak/);
  await f.say('report at 11 PM');assert.equal(f.store.getSetting('report_time'),'23:00');
  assert.equal(f.store.getSetting('daily_time')??'08:00','08:00');
});

test('a report and reminder due together share one message without duplicate habit rows',async t=>{
  const f=new Fixture(t);await f.say('Track Read every day');
  await f.say('report at 8 AM');f.now=new Date('2026-10-18T00:00:00Z');f.scheduler.tick();
  const reports=f.reports();assert.equal(reports.length,1);
  const input=JSON.parse(reports[0]!.payload) as Input;assert.equal(input.notification!.daily,true);
  const reply=JSON.parse(reports[0]!.response!) as {text:string;buttons:unknown[][]};
  assert.equal(reply.text.match(/Read ·/g)!.length,1);assert.equal(reply.buttons.length,1);
});

test('actual Telegram handler delivers the scheduled report to its configured owner',async t=>{
  const f=new Fixture(t);await f.say('Track Read every day');await f.say('I read today');
  const info:UserFromGetMe={id:456,is_bot:true,first_name:'Habit',username:'SyntheticHabitBot',can_join_groups:false,can_read_all_group_messages:false,supports_inline_queries:false,
    can_connect_to_business:false,has_main_web_app:false,has_topics_enabled:false,allows_users_to_create_topics:false,can_manage_bots:false,supports_join_request_queries:false};
  const bot=new Bot('123:synthetic',{botInfo:info}),sent:{chat_id:number;text:string}[]=[];
  bot.api.config.use(async(_prev,method,payload)=>{if(method==='sendMessage')sent.push(payload as typeof sent[number]);return {ok:true,result:true} as never;});
  const tick=installHandlers(bot,'123',f.store,f.service,()=>f.now);
  f.now=new Date('2026-10-18T15:00:00Z');await tick();await tick();
  const reports=sent.filter(p=>p.text.startsWith('Your daily streak report'));
  assert.equal(reports.length,1);assert.equal(reports[0]!.chat_id,123);assert.match(reports[0]!.text,/Read · 1-day streak/);
});
