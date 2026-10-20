import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Bot} from 'grammy';
import type {Update,UserFromGetMe} from 'grammy/types';
import {Store,type Input,type Reply} from '../src/store.js';
import {HabitService} from '../src/service.js';
import {ReminderScheduler} from '../src/reminders.js';
import {flushOutbox,installHandlers} from '../src/telegram.js';
import {parseTime,clockAt} from '../src/dates.js';
import type {Interpreter} from '../src/ai.js';

class Fixture {
  directory=mkdtempSync(join(tmpdir(),'habit-conversation-test-'));
  path=join(this.directory,'habits.sqlite');
  now=new Date('2026-10-17T23:00:00Z'); // 07:00 Manila, October 18.
  store=new Store(this.path,'123','Asia/Manila');
  service: HabitService;
  scheduler: ReminderScheduler;
  next=0;
  constructor(t:TestContext,private ai?:Interpreter) {
    this.service=new HabitService(this.store,'Asia/Manila',ai,()=>this.now);
    this.scheduler=new ReminderScheduler(this.store,'Asia/Manila',()=>this.now);
    this.activate();
    t.after(()=>{this.store.close();rmSync(this.directory,{recursive:true,force:true});});
  }
  activate(){this.store.setSetting('chat_id','123');this.store.setSetting('activated_at',this.now.toISOString());}
  async say(text:string,kind:'text'|'callback'='text'):Promise<Reply>{
    const n=++this.next;const input:Input={updateId:n,sourceId:kind+':'+n,chatId:123,userId:123,kind,text,at:this.now.toISOString()};
    return this.service.process(this.store.enqueue(input));
  }
  reopen(){this.store.close();this.store=new Store(this.path,'123','Asia/Manila');this.service=new HabitService(this.store,'Asia/Manila',this.ai,()=>this.now);this.scheduler=new ReminderScheduler(this.store,'Asia/Manila',()=>this.now);}
  notifications(){return this.store.outbox(this.now.getTime()).filter(r=>(JSON.parse(r.payload) as Input).kind==='notification');}
}

test('plain chat adds daily and weekly habits, logs, removes, and restores without slash commands',async t=>{
  const f=new Fixture(t);
  await f.say('Track Read every day');await f.say('Track exercise three times a week');
  assert.equal(f.store.findHabit('Exercise')!.target,3);
  const log=await f.say('I read today');assert.match(log.text,/Read marked complete/);
  assert.equal(f.store.logs(f.store.findHabit('Read')!.id).length,1);
  assert.match((await f.say('How did I do this week?')).text,/Read: 1\/1/);
  const remove=await f.say('remove Read');assert.equal(f.store.findHabit('Read')!.active,0);
  assert.equal(f.store.logs(f.store.findHabit('Read')!.id).length,1);
  await f.say(remove.buttons![0]![0]!.callback_data,'callback');assert.equal(f.store.findHabit('Read')!.active,1);
});

test('guided setup survives restart and uses buttons for cadence and weekly target',async t=>{
  const f=new Fixture(t);await f.say('Add habit');f.reopen();
  const cadence=await f.say('Exercise');f.reopen();
  const target=await f.say(cadence.buttons![0]![1]!.callback_data,'callback');
  await f.say(target.buttons![0]![1]!.callback_data,'callback');
  assert.equal(f.store.findHabit('Exercise')!.target,3);
  assert.equal(f.store.findHabit('Exercise')!.reminder_time,'08:00');
  assert.equal(f.store.conversation(),undefined);
});

test('navigation cancels a draft and stale setup buttons cannot change a new draft',async t=>{
  const f=new Fixture(t);await f.say('Add habit');const old=await f.say('Read');
  await f.say('Today');await f.say('Add habit');await f.say('Walk');
  assert.match((await f.say(old.buttons![0]![0]!.callback_data,'callback')).text,/expired/);
  assert.equal(f.store.habits().length,0);
  await f.say('Cancel');assert.equal(f.store.conversation(),undefined);
});

test('My habits routes reminder changes and removal through buttons',async t=>{
  const f=new Fixture(t);await f.say('Track Read every day');
  const list=await f.say('My habits');const details=await f.say(list.buttons![0]![0]!.callback_data,'callback');
  await f.say(details.buttons![0]![0]!.callback_data,'callback');
  await f.say('8 pm');assert.equal(f.store.findHabit('Read')!.reminder_time,'20:00');
  const removed=await f.say(details.buttons![1]![0]!.callback_data,'callback');assert.equal(f.store.findHabit('Read')!.active,0);
  await f.say(removed.buttons![0]![0]!.callback_data,'callback');assert.equal(f.store.findHabit('Read')!.active,1);
});

test('daily reminder time can be changed or disabled in chat and survives restart',async t=>{
  const f=new Fixture(t);const settings=await f.say('Reminders');
  await f.say(settings.buttons![0]![0]!.callback_data,'callback');await f.say('9 AM');f.reopen();
  assert.equal(f.store.getSetting('daily_time'),'09:00');
  const next=await f.say('Reminders');await f.say(next.buttons![0]![1]!.callback_data,'callback');
  assert.equal(f.store.getSetting('daily_enabled'),'false');
});

test('Undo cannot overwrite a later change and replayed Undo has no second effect',async t=>{
  const f=new Fixture(t);await f.say('Track Read every day');
  const done=await f.say('I read today');await f.say('/skip Read');
  assert.match((await f.say(done.buttons![0]![0]!.callback_data,'callback')).text,/newer change/);
  assert.equal(f.store.logs(f.store.findHabit('Read')!.id)[0]!.status,'skipped');
  const remove=await f.say('remove Read');const undo=remove.buttons![0]![0]!.callback_data;
  await f.say(undo,'callback');await f.say(undo,'callback');assert.equal(f.store.findHabit('Read')!.active,1);
});

test('a legacy Undo button cannot delete a newer check-in',async t=>{
  const f=new Fixture(t);await f.say('Track Read every day');const h=f.store.findHabit('Read')!;
  await f.say('I read today');await f.say('/skip Read');
  assert.match((await f.say('h:undo:'+h.id+':2026-10-18','callback')).text,/older Undo has expired/);
  assert.equal(f.store.logs(h.id)[0]!.status,'skipped');
});

test('ambiguous habit names require a choice before a completion is logged',async t=>{
  const f=new Fixture(t);await f.say('Track Read every day');await f.say('Track Read for 20 minutes every day');
  const choice=await f.say('I read for 20 minutes today');
  assert.match(choice.text,/Which habit/);
  for(const h of f.store.habits()) assert.equal(f.store.logs(h.id).length,0);
  f.reopen();await f.say(choice.buttons![1]![0]!.callback_data,'callback');
  assert.equal(f.store.logs(f.store.findHabit('Read')!.id).length,0);
  assert.equal(f.store.logs(f.store.findHabit('Read for 20 minutes')!.id).length,1);
});

test('AI can create the first habit and clarification retains its original context',async t=>{
  let calls=0,second='';
  const ai:Interpreter={interpret:async text=>{
    if(++calls===1) return {kind:'clarify',question:'How many days each week?'};
    second=text;return {kind:'create',name:'Walk',cadence:'weekly',target:3};
  }};
  const f=new Fixture(t,ai);assert.match((await f.say('Help me make time for a walk')).text,/How many/);
  f.reopen();await f.say('three');assert.match(second,/Help me make time for a walk/);assert.match(second,/three/);
  assert.equal(f.store.findHabit('Walk')!.target,3);
});

test('time parsing accepts 12-hour and 24-hour input and rejects impossible times',()=>{
  assert.equal(parseTime('8am'),'08:00');assert.equal(parseTime('12 AM'),'00:00');assert.equal(parseTime('12 PM'),'12:00');
  assert.equal(parseTime('20:30'),'20:30');assert.equal(parseTime('8:99 AM'),undefined);assert.equal(parseTime('25:00'),undefined);
  assert.equal(clockAt(new Date('2026-10-18T00:00:00Z'),'Asia/Manila'),'08:00');
});

test('8 AM Manila creates one combined daily and habit message, including after restart',async t=>{
  const f=new Fixture(t);await f.say('Track Read every day');
  f.now=new Date('2026-10-17T23:59:00Z');f.scheduler.tick();assert.equal(f.notifications().length,0);
  f.now=new Date('2026-10-18T00:00:00Z');f.scheduler.tick();f.scheduler.tick();
  assert.equal(f.notifications().length,1);
  const input=JSON.parse(f.notifications()[0]!.payload) as Input;
  assert.equal(input.notification!.daily,true);assert.equal(input.notification!.habitIds.length,1);
  f.reopen();f.scheduler.tick();assert.equal(f.notifications().length,1);
});

test('habit reminders skip done, skipped, archived habits and never nag after an Undo',async t=>{
  const f=new Fixture(t);f.store.setSetting('daily_enabled','false');
  await f.say('Track Read every day');await f.say('Track Walk every day');await f.say('Track Exercise every day');
  await f.say('I read today');await f.say('/skip Walk');await f.say('remove Exercise');
  f.now=new Date('2026-10-18T00:00:00Z');f.scheduler.tick();assert.equal(f.notifications().length,0);
  await f.say('/undo Read');f.scheduler.tick();assert.equal(f.notifications().length,0);
});

test('weekly reminders stop after their target has been met',async t=>{
  const f=new Fixture(t);f.now=new Date('2026-10-11T23:00:00Z');f.activate();f.store.setSetting('daily_enabled','false');
  await f.say('Track Exercise three times a week');
  for(const date of ['2026-10-12','2026-10-13','2026-10-14']){f.now=new Date(date+'T00:00:00Z');await f.say('/done Exercise');}
  f.now=new Date('2026-10-15T00:00:00Z');f.scheduler.tick();assert.equal(f.notifications().length,0);
});

test('individual reminder times are independent from the daily check-in',async t=>{
  const f=new Fixture(t);await f.say('Track Read every day');const habit=f.store.findHabit('Read')!;
  f.store.setReminder(habit.id,'09:00',f.now.toISOString());
  f.now=new Date('2026-10-18T00:00:00Z');f.scheduler.tick();
  assert.equal((JSON.parse(f.notifications()[0]!.payload) as Input).notification!.habitIds.length,0);
  f.now=new Date('2026-10-18T01:00:00Z');f.scheduler.tick();assert.equal(f.notifications().length,2);
});

test('a missed reminder catches up within an hour but not after its window',async t=>{
  const f=new Fixture(t);await f.say('Track Read every day');f.now=new Date('2026-10-18T00:30:00Z');f.scheduler.tick();
  assert.equal(f.notifications().length,1);
  f.now=new Date('2026-10-19T02:00:00Z');f.scheduler.tick();
  assert.equal(f.store.occurred('daily:2026-10-19'),true);
  assert.equal(f.notifications().length,1); // Only the prior queued occurrence; no stale catch-up.
});

test('a schedule first set after its time starts the next day',async t=>{
  const f=new Fixture(t);f.now=new Date('2026-10-18T00:15:00Z');f.activate();await f.say('Track Read every day');
  f.scheduler.tick();assert.equal(f.notifications().length,0);
  f.now=new Date('2026-10-19T00:00:00Z');f.scheduler.tick();assert.equal(f.notifications().length,1);
});

test('failed reminder delivery retries without another occurrence, then suppresses a completed habit',async t=>{
  const f=new Fixture(t);f.store.setSetting('daily_enabled','false');await f.say('Track Read every day');
  f.now=new Date('2026-10-18T00:00:00Z');f.scheduler.tick();
  await flushOutbox(f.store,{send:async()=>{throw new Error('offline');}},f.now.getTime());
  f.reopen();f.scheduler.tick();assert.equal(f.notifications().length,0); // Retry time is still in the future.
  f.now=new Date('2026-10-18T00:10:00Z');await f.say('I read today');
  const sent:string[]=[];await flushOutbox(f.store,{send:async(_chat,reply)=>{sent.push(reply.text);}},f.now.getTime());
  assert.equal(sent.some(s=>s.startsWith('A reminder')),false);
  const discarded=f.store.db.prepare("SELECT count(*) AS n FROM intake WHERE discard_reason='expired_or_no_longer_due'").get()!;
  assert.equal(discarded.n,1);
});

test('past-day notifications expire before delivery after an offline restart',async t=>{
  const f=new Fixture(t);await f.say('Track Read every day');f.now=new Date('2026-10-18T00:00:00Z');f.scheduler.tick();
  f.reopen();f.now=new Date('2026-10-19T00:00:00Z');const sent:string[]=[];
  await flushOutbox(f.store,{send:async(_chat,reply)=>{sent.push(reply.text);}},f.now.getTime());
  assert.equal(sent.some(s=>s.startsWith('Good morning')),false);
});

test('queued habit and daily reminders are canceled when their schedule changes',async t=>{
  const f=new Fixture(t);await f.say('Track Read every day');
  f.now=new Date('2026-10-18T00:00:00Z');f.scheduler.tick();
  await flushOutbox(f.store,{send:async()=>{throw new Error('offline');}},f.now.getTime());
  f.now=new Date('2026-10-18T00:05:00Z');
  f.store.setReminder(f.store.findHabit('Read')!.id,'20:00',f.now.toISOString());
  f.store.setSetting('daily_time','20:00');f.store.setSetting('daily_set_at',f.now.toISOString());
  f.now=new Date('2026-10-18T00:06:00Z');const sent:string[]=[];
  await flushOutbox(f.store,{send:async(_chat,reply)=>{sent.push(reply.text);}},f.now.getTime());
  assert.equal(sent.some(s=>s.startsWith('Good morning')||s.startsWith('A reminder')),false);
});

test('notification insertion and occurrence identity roll back together on storage failure',async t=>{
  const f=new Fixture(t);await f.say('Track Read every day');f.now=new Date('2026-10-18T00:00:00Z');
  const original=f.store.queueNotification.bind(f.store);
  f.store.queueNotification=(...args)=>{original(...args);throw new Error('synthetic storage fault');};
  assert.throws(()=>f.scheduler.tick(),/storage fault/);assert.equal(f.notifications().length,0);assert.equal(f.store.occurred('daily:2026-10-18'),false);
  f.store.queueNotification=original;f.scheduler.tick();assert.equal(f.notifications().length,1);
});

test('scheduler never sends before the private owner has activated the bot',async t=>{
  const f=new Fixture(t);f.store.db.prepare("DELETE FROM meta WHERE key IN ('chat_id','activated_at')").run();
  await f.say('Track Read every day');f.now=new Date('2026-10-18T00:00:00Z');f.scheduler.tick();assert.equal(f.notifications().length,0);
});

test('actual Telegram handler shows the menu, guides setup, sends at 8 AM, and routes its Done button',async t=>{
  const f=new Fixture(t);
  const info:UserFromGetMe={id:456,is_bot:true,first_name:'Habit',username:'SyntheticHabitBot',can_join_groups:false,can_read_all_group_messages:false,supports_inline_queries:false,
    can_connect_to_business:false,has_main_web_app:false,has_topics_enabled:false,allows_users_to_create_topics:false,can_manage_bots:false,supports_join_request_queries:false};
  const bot=new Bot('123:synthetic',{botInfo:info});
  type Sent={text:string;reply_markup?:{is_persistent?:boolean;keyboard?:{text:string}[][];inline_keyboard?:{text:string;callback_data:string}[][]}};
  const sent:Sent[]=[];
  bot.api.config.use(async(_prev,method,payload)=>{if(method==='sendMessage')sent.push(payload as Sent);return {ok:true,result:true} as never;});
  const tick=installHandlers(bot,'123',f.store,f.service,()=>f.now);
  const message=(text:string,n:number):Update=>({update_id:n,message:{message_id:n,date:f.now.getTime()/1000,chat:{id:123,type:'private',first_name:'Synthetic'},from:{id:123,is_bot:false,first_name:'Synthetic'},text}});
  const callback=(data:string,n:number):Update=>({update_id:n,callback_query:{id:'guided-'+n,chat_instance:'synthetic',from:{id:123,is_bot:false,first_name:'Synthetic'},message:message('',n).message!,data}});
  await bot.handleUpdate(message('/start',1));
  assert.equal(sent[0]!.reply_markup!.is_persistent,true);assert.equal(sent[0]!.reply_markup!.keyboard![0]![1]!.text,'Add habit');
  await bot.handleUpdate(message('Add habit',2));await bot.handleUpdate(message('Read',3));
  await bot.handleUpdate(callback(sent.at(-1)!.reply_markup!.inline_keyboard![0]![0]!.callback_data,4));
  f.now=new Date('2026-10-18T00:00:00Z');await tick();
  const reminder=sent.at(-1)!;assert.match(reminder.text,/Good morning/);
  assert.equal(sent.filter(s=>s.text.startsWith('Good morning')).length,1);
  const done=reminder.reply_markup!.inline_keyboard![0]![0]!.callback_data;
  await bot.handleUpdate(callback(done,5));await tick();
  assert.equal(f.store.logs(f.store.findHabit('Read')!.id)[0]!.source_id,'callback:guided-5');
  assert.equal(sent.filter(s=>s.text.startsWith('Good morning')).length,1);
});

test('schema v1 migration preserves habits, logs, pending replies, and old proposals',t=>{
  const directory=mkdtempSync(join(tmpdir(),'habit-migration-test-')),path=join(directory,'habits.sqlite');
  const old=new DatabaseSync(path);
  old.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES('owner','123'),('timezone','Asia/Manila'),('schema_version','1');
    CREATE TABLE habit(id TEXT PRIMARY KEY,name TEXT NOT NULL,name_key TEXT NOT NULL UNIQUE,cadence TEXT NOT NULL,target INTEGER NOT NULL,created_day TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
    INSERT INTO habit VALUES('aaaaaaaaaaaa','Read','read','daily',7,'2026-10-18',1);
    CREATE TABLE habit_log(habit_id TEXT NOT NULL,day TEXT NOT NULL,status TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(habit_id,day));
    INSERT INTO habit_log VALUES('aaaaaaaaaaaa','2026-10-18','done','123:1');
    CREATE TABLE intake(id INTEGER PRIMARY KEY,source_id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,response TEXT,sent INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0);
    INSERT INTO intake VALUES(1,'123:1','{}','{"text":"Saved"}',0,0,0);
    CREATE TABLE proposal(id TEXT PRIMARY KEY,events TEXT NOT NULL,created_day TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'open');
    INSERT INTO proposal VALUES('bbbbbbbbbbbb','[]','2026-10-18','open');`);
  old.close();const store=new Store(path,'123','Asia/Manila');
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  assert.equal(store.getSetting('schema_version'),'2');assert.equal(store.habits()[0]!.reminder_time,'08:00');
  assert.equal(store.logs('aaaaaaaaaaaa')[0]!.source_id,'123:1');assert.equal(store.outbox(0)[0]!.response,'{"text":"Saved"}');
  assert.equal(store.proposal('bbbbbbbbbbbb')!.state,'open');
});
