import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openSetupCatalog } from '../scripts/setup_catalog.mjs';
import { temporary } from './hook_fixture.mjs';

const neon = 'gemini-4-neon', argon = 'gemini-4-argon';
const checks = { agy_path: '/official/agy', google_auth_method: 'existing-session' };

// Stand in for Codex with prerecorded metadata. No ACP client or provider runs in this fixture.
const fixture = `
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
const [dir, mode] = process.argv.slice(2);
const scratch = tmpdir();
if (scratch !== join(process.cwd(), 'tmp') || Object.values({TMP:process.env.TMP,TEMP:process.env.TEMP,TMPDIR:process.env.TMPDIR})
  .some(value => value !== scratch)) throw Error('child temp directory is not isolated');
fs.mkdtempSync(join(scratch, '.tmp'));
fs.appendFileSync(join(dir, 'starts'), process.cwd() + '\\n');
const file = 'provider-output.jsonl', sessionId = 'test-session';
const neon = 'gemini-4-neon', argon = 'gemini-4-argon';
const frame = (id, result) => JSON.stringify({jsonrpc:'2.0',id,result}) + '\\n';
const options = currentValue => [
  {id:'catalog-model',category:'model',type:'select',currentValue,
    options:[{value:neon,name:'霓虹'},{value:argon,name:'氩'}]},
  {id:'level',category:'thought_level',type:'select',currentValue:'medium',
    options:[{value:'medium'}, {value:currentValue === argon ? 'high' : 'low'}]}
];
if (mode === 'exit-before-ready') process.exit(2);
if (mode === 'stuck') {
  process.on('SIGINT', () => {});
  while(true) await sleep(50);
}
fs.appendFileSync(file, frame(1,{protocolVersion:1}));
if (mode === 'explicit-auth') fs.appendFileSync(file, frame(2,{}));
if (mode === 'too-large') { fs.appendFileSync(file,'x'.repeat(1024*1024+20)); process.exit(0); }
const ready = Buffer.from(frame(3,{sessionId,configOptions:options(neon)}));
if (mode === 'oversized-config') {
  fs.appendFileSync(file, frame(3,{sessionId,configOptions:options(neon),pad:'x'.repeat(1024*1024)}));
  process.exit(0);
}
const split = ready.indexOf(Buffer.from('霓虹')) + 2;
fs.appendFileSync(file, ready.subarray(0,split));
await sleep(75);
fs.appendFileSync(file, ready.subarray(split));
if (mode === 'early-switch') fs.appendFileSync(file, frame(4,{configOptions:options(argon)}));
if (mode === 'exit-after-list') process.exit(0);
let choice;
while (!choice) {
  const entry=fs.readdirSync('.').find(name=>/^selection-[a-f0-9-]+\\.json$/.test(name));
  if(entry) choice=JSON.parse(fs.readFileSync(entry));
  else await sleep(5);
}
fs.writeFileSync(join(dir, 'choice'), JSON.stringify(choice));
if(choice.model){
  const configOptions = options(mode === 'wrong-model' ? neon : choice.model);
  fs.appendFileSync(file, JSON.stringify({jsonrpc:'2.0',method:'session/update',
      params:{sessionId,update:{sessionUpdate:'available_commands_update',text:'a'.repeat(1100000)}}}) + '\\n');
  const result = mode === 'wrong-session' ? {sessionId:'other',configOptions} : {configOptions};
  fs.appendFileSync(file, frame(4,result));
}
fs.appendFileSync(file,frame(7,{}));
`;

function launch(t, mode = 'success', opts = {}) {
  const dir = temporary(t);
  const fixtureFile = join(dir, 'metadata.mjs');
  fs.writeFileSync(fixtureFile, fixture);
  const session = openSetupCatalog({ ...checks, ...opts.checks }, {
    cli: { command: process.execPath, args: [fixtureFile,dir,mode] },
    closeGraceMs: 300, timeoutMs: 5_000, ...opts.session
  });
  t.after(() => session.close());
  function workspace() { return fs.readFileSync(join(dir, 'starts'), 'utf8').trim(); }
  function choice() { return JSON.parse(fs.readFileSync(join(dir, 'choice'), 'utf8')); }
  return { session, workspace, choice, dir };
}

test('live catalog publishes each menu before exit and switches a noncurrent model in the same session', async t => {
  const { session, workspace, choice } = launch(t);
  const [account, repeated] = await Promise.all([session.list(),session.list()]);
  assert.equal(account, repeated);
  assert.deepEqual(account.models, [{id:neon,name:'霓虹'}, {id:argon,name:'氩'}]);
  await assert.rejects(session.select('unadvertised'), /unavailable/);
  const switched = await session.select(argon);
  assert.equal(switched.current_model, argon);
  assert.deepEqual(switched.thinking_levels.map(x=>x.id), ['medium','high']);
  assert.deepEqual(choice(), {model:argon});
  assert.ok(fs.existsSync(workspace()), 'one child started in its original workspace');
  await Promise.all([session.close(),session.close()]);
  assert.ok(!fs.existsSync(workspace()));
  await assert.rejects(session.list(), /closed/);
});

test('current model uses already received levels and lets the same Codex process close', async t => {
  const { session, choice } = launch(t, 'explicit-auth', { checks:{google_auth_method:'gemini-api-key'} });
  const initial = await session.list();
  assert.equal(await session.select(neon), initial);
  await session.close();
  assert.deepEqual(choice(), {close:true});
});

test('cancel an open list or an unopened picker without starting another process', async t => {
  const unopened = launch(t);
  await unopened.session.close();
  assert.ok(!fs.existsSync(join(unopened.dir, 'starts')));
  const {session,workspace,choice} = launch(t);
  await session.list();
  assert.equal(fs.readdirSync(join(workspace(),'tmp')).length, 1, 'Codex left an ephemeral directory');
  await session.close();
  assert.deepEqual(choice(), {close:true});
  assert.ok(!fs.existsSync(workspace()));
  await assert.rejects(session.select(argon), /closed/);
});

test('cleanup preserves a replacement for the original scratch directory', async t => {
  const { session, workspace, dir } = launch(t);
  await session.list();
  const ownedWorkspace = workspace();
  t.after(() => fs.rmSync(ownedWorkspace, { recursive:true, force:true }));
  const scratch = join(ownedWorkspace, 'tmp');
  fs.renameSync(scratch, join(dir, 'moved-original'));
  fs.mkdirSync(scratch);
  const other = join(scratch,'unrelated');
  fs.writeFileSync(other, 'keep');
  await session.close();
  assert.equal(fs.readFileSync(other, 'utf8'), 'keep');
});

test('catalog rejects an unsolicited model switch, a mismatched reply, and a switch after process exit', async t => {
  for (const mode of ['early-switch','wrong-model','wrong-session','exit-after-list']) {
    const {session,workspace} = launch(t,mode);
    await assert.rejects(session.select(argon));
    await session.close();
    assert.ok(!fs.existsSync(workspace()));
  }
});

test('catalog rejects incomplete startup, missing authentication and oversized frames and disposes its workspace', async t => {
  for (const [mode,auth] of [['exit-before-ready','existing-session'],['success','agent-platform'],
    ['too-large','existing-session'],['oversized-config','existing-session']]) {
    const {session,workspace} = launch(t, mode, { checks:{google_auth_method:auth} });
    await assert.rejects(session.list());
    await session.close();
    assert.ok(!fs.existsSync(workspace()));
  }
});

test('timeout and explicit cancellation settle pending lookups and remove a stuck child', async t => {
  const timeout = launch(t,'stuck', { session:{timeoutMs:process.platform === 'win32' ? 2000 : 300,closeGraceMs:10} });
  await assert.rejects(timeout.session.list(), /timeout/);
  await timeout.session.close();
  assert.ok(!fs.existsSync(timeout.workspace()));

  const {session,workspace,dir} = launch(t,'stuck', { session:{closeGraceMs:10} });
  const pending = assert.rejects(session.list(), /closed/);
  const deadline = Date.now() + 5_000;
  while(!fs.existsSync(join(dir,'starts')) && Date.now()<deadline) await sleep(10);
  await session.close();
  await pending;
  assert.ok(!fs.existsSync(workspace()));
});
