// Offline stand-ins for the command-line hosts. All state lives in the test home.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { buffer } from 'node:stream/consumers';
import { setTimeout as sleep } from 'node:timers/promises';

const [host, ...args] = process.argv.slice(2);
const { POLISH_TEST_CLI_LOG: log, POLISH_TEST_SCENARIO: scenario, POLISH_TEST_REPLY: body, CODEX_HOME: profile, HOME: home } = process.env;
const codexProvider = JSON.parse(process.env.POLISH_TEST_CODEX_PROVIDER || '{}');
const index = '.agents/plugins/marketplace.json';
const marketName = 'codex-polish-local';
const pluginId = 'codex-polish@' + marketName;
const codexState = join(profile, 'fake-registration.json');
const agyPlugins = join(home, '.gemini', 'config', 'plugins');
const agyConfig = join(dirname(agyPlugins), 'config.json');

function record(entry = {}) {
  fs.appendFileSync(log, JSON.stringify({ host, args, ...entry }) + '\n');
}

function state() {
  return fs.existsSync(codexState) ? JSON.parse(fs.readFileSync(codexState, 'utf8')) : {};
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function reply(data) {
  console.log(JSON.stringify(data));
}

function setAgyEnabled(name, enabled) {
  const config = fs.existsSync(agyConfig) ? readJson(agyConfig) : { plugins: {} };
  if (enabled === undefined) delete config.plugins[name];
  else config.plugins[name] = { enabled };
  fs.writeFileSync(agyConfig, JSON.stringify(config));
}

const [command, action, target] = args;
if (args.includes('--version')) {
  record();
  console.log(host === 'agy' ? '1.5.8' : 'codex-cli 0.170.0');
} else if (args.includes('--help') && !args.includes('exec')) {
  record();
  console.log('  acp   Start the ACP server\n  plugin   Manage plugins');
} else if (host === 'codex' && args.includes('exec')) {
  record({ kind: 'exec-start' });
  const flag = args.findIndex(arg => arg === '-o' || arg === '--output-last-message');
  const output = flag < 0 ? args.find(arg => arg.startsWith('--output-last-message='))?.split(/=(.*)/s)[1] : args[flag + 1];
  const prompt = (await buffer(process.stdin)).toString('utf8');
  assert.ok(output, 'Codex exec requires an output file');
  console.log('UNTRUSTED_STDOUT_CHUNK');
  if (scenario === 'empty') fs.writeFileSync(output, ' \n\t\n');
  const result = (reply, complete = true) => args.includes('--output-schema') ? JSON.stringify({ reply, complete }) : reply;
  if (['nonzero', 'permission-denied', 'cancel'].includes(scenario)) {
    // Even a valid-looking final file must be discarded when exec fails or hangs.
    fs.writeFileSync(output, result(body));
  }
  if (scenario === 'incomplete') fs.writeFileSync(output, result(body, false));
  if (scenario === 'truncated') fs.writeFileSync(output, '{"reply":' + JSON.stringify(body));
  if (scenario === 'success') fs.writeFileSync(output, result(body));
  record({ kind: 'exec', prompt, pid: process.pid, cwd: process.cwd(), profile });
  if (scenario === 'cancel') await sleep(12_000);
  if (scenario === 'permission-denied') console.error('Permission denied: cached output');
  if (scenario === 'nonzero' || scenario === 'permission-denied') process.exitCode = 1;
} else if (host === 'codex' && args.includes('app-server')) {
  record();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let initialized = false;
  for await (const line of lines) {
    const { id, method, params } = JSON.parse(line);
    record({ method, params });
    if (method === 'initialized') initialized = true;
    if (id === undefined) continue;
    let result;
    if (method === 'initialize') result = { userAgent: 'codex-test', codexHome: profile, platformFamily: 'unix', platformOs: process.platform };
    else if (!initialized) throw new Error('App Server handshake is incomplete');
    else if (method === 'model/list') {
      const model = (id, displayName, reasoningEfforts) => ({
        id, model: id, displayName, description: displayName, hidden: false, isDefault: id === 'fixture-model',
        defaultReasoningEffort: reasoningEfforts[0],
        supportedReasoningEfforts: reasoningEfforts.map(reasoningEffort => ({ reasoningEffort, description: 'fixture effort' })),
        inputModalities: ['text'], supportsPersonality: false
      });
      result = params.cursor === 'next-page'
        ? { data: [model('fixture-other', 'Other model', ['medium'])], nextCursor: null }
        : { data: [model('fixture-model', '模型 Café', ['low', 'xhigh'])], nextCursor: 'next-page' };
    } else if (method === 'hooks/list') {
      result = { data: [{ hooks: [{ pluginId, eventName: 'userPromptSubmit', enabled: true, trustStatus: 'untrusted' }] }] };
    } else if (method === 'config/read') {
      if (codexProvider.configError) {
        reply({ id, error: { code: -32603, message: codexProvider.configError } });
        continue;
      }
      result = { config: codexProvider.config ?? {} };
    } else if (method === 'account/read') {
      assert.deepEqual(params, { refreshToken: false });
      result = codexProvider.accountResponse ?? { requiresOpenaiAuth: true, account: { type: 'chatgpt' } };
    } else if (method === 'config/value/write') {
      const old = state();
      if (old.plugin) old.plugin.enabled = params.value;
      fs.writeFileSync(codexState, JSON.stringify(old));
      result = { status: 'ok' };
    } else throw new Error(`Unexpected Codex RPC ${method}`);
    reply({ id, result });
  }
} else if (host === 'codex' && command === 'login' && action === 'status') {
  record();
  process.exitCode = codexProvider.loginStatus ?? 0;
  console.log(process.exitCode ? 'Not logged in' : 'Logged in using test fixture');
} else if (host === 'codex' && command === 'plugin') {
  record();
  const old = state();
  let result = {};
  if (action === 'marketplace' && target === 'list') {
    result = { marketplaces: old.market ? [{ name: marketName, root: old.market, marketplaceSource: { sourceType: 'local', source: old.market } }] : [] };
  } else if (action === 'marketplace' && target === 'add') old.market = args[3];
  else if (action === 'marketplace' && target === 'remove') delete old.market;
  else if (action === 'list') result = { installed: old.plugin ? [old.plugin] : [] };
  else if (action === 'add') {
    assert.equal(target, pluginId);
    const installedPath = join(profile, 'fake-cache');
    const { plugins: [entry] } = readJson(join(old.market, index));
    const source = join(old.market, entry.source.path);
    const { version } = readJson(join(source, '.codex-plugin', 'plugin.json'));
    fs.rmSync(installedPath, { recursive: true, force: true });
    fs.cpSync(source, installedPath, { recursive: true });
    old.plugin = { pluginId, version, installedPath, enabled: true };
    result = old.plugin;
  } else if (action === 'remove') {
    assert.equal(target, pluginId);
    fs.rmSync(join(profile, 'fake-cache'), { recursive: true, force: true });
    delete old.plugin;
  } else throw new Error(`Unexpected Codex plugin command: ${args.join(' ')}`);
  if (action !== 'list' && target !== 'list') fs.writeFileSync(codexState, JSON.stringify(old));
  reply(result);
} else if (host === 'agy' && command === 'plugin') {
  record();
  if (action === 'validate') {
    const manifest = 'plugin.json';
    reply({ name: readJson(join(target, manifest)).name, manifest, strict: false, warnings: [] });
  } else if (action === 'install') {
    const manifest = readJson(join(target, 'plugin.json'));
    const destination = join(agyPlugins, manifest.name);
    fs.mkdirSync(dirname(destination), { recursive: true });
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(target, destination, { recursive: true });
    setAgyEnabled(manifest.name, true);
    console.log(`Installed plugin "${manifest.name}" from local path`);
  } else if (action === 'uninstall') {
    fs.rmSync(join(agyPlugins, target), { recursive: true, force: true });
    setAgyEnabled(target, undefined);
    console.log(`Uninstalled plugin "${target}"`);
  } else if (action === 'enable' || action === 'disable') {
    fs.accessSync(join(agyPlugins, target, 'plugin.json'));
    setAgyEnabled(target, action === 'enable');
  } else if (action === 'list') {
    const names = fs.existsSync(agyPlugins) ? fs.readdirSync(agyPlugins) : [];
    const config = fs.existsSync(agyConfig) ? readJson(agyConfig) : { plugins: {} };
    reply(names.map(name => {
      const path = join(agyPlugins, name);
      const { version } = readJson(join(path, 'plugin.json'));
      return { name, version, enabled: config.plugins[name]?.enabled !== false, path };
    }));
  } else throw new Error(`Unexpected Antigravity plugin command: ${args.join(' ')}`);
} else {
  record();
  throw new Error(`Unexpected ${host} command: ${args.join(' ')}`);
}
