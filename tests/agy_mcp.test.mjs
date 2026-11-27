import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { text } from 'node:stream/consumers';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { executable } from '../plugins/codex-polish/hooks/platform.mjs';
import { nativeConfig } from '../scripts/install.mjs';
import { windows } from './hook_fixture.mjs';
import { isolatedHosts, reversePlugin, settingsModule, shellQuote, until, withSettings, write } from './host_fixture.mjs';

const material = {
  question: '为什么要保留空行？ 🧪',
  draft: '## 原始答案 café\n\n开头一段。  \n\n```js\nconst 原文 = "🗺️";\n```\n\n- 最后一段。\n',
  trigger: 'explicit'
};
const polished = '## 改写后的答案 🧪\n\n调整后的段落。  \n\n```js\nconst 原文 = "🗺️";\n```\n\n- 最后一段。\n';
const codexTest = (name, fn) => test(name, { skip: windows && 'requires POSIX fake codex executable' }, fn);
const nativeCodex = executable('codex');
const runFile = promisify(execFile);

function execs(fixture) {
  return fixture.records().filter(record => record.kind === 'exec');
}

function submissions(fixture) {
  return fixture.records().filter(record => record.kind === 'exec-start').length;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function connect(fixture, { requestTimeout = 5000 } = {}) {
  const staged = join(fixture.base, '已安装 plugin');
  fs.cpSync(reversePlugin, staged, { recursive: true });
  const config = JSON.parse(fs.readFileSync(join(staged, 'mcp_config.json'), 'utf8'));
  const [server] = Object.values(config.mcpServers ?? {}).filter(entry => entry.command);
  assert.ok(server, 'plugin must declare a stdio MCP server in mcp_config.json');
  const data = join(fixture.base, 'Plugin data');
  const expand = value => value.replaceAll('${PLUGIN_ROOT}', staged).replaceAll('${PLUGIN_DATA}', data);
  const env = { ...fixture.env, PLUGIN_ROOT: staged, PLUGIN_DATA: data,
    ...Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, expand(value)])) };
  // The PATH only contains fixture programs. On Windows use this Node process's executable.
  const command = expand(server.command) === 'node' ? process.execPath : expand(server.command);
  const child = spawn(command, (server.args ?? []).map(expand), {
    env, cwd: server.cwd ? expand(server.cwd) : fixture.workspace, stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map(), replies = [];
  let stderr = '', fault, invalidOutput;
  const fail = error => {
    fault ??= error;
    for (const { reject } of pending.values()) reject(fault);
  };
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.on('error', fail);
  child.stdin.on('error', fail);
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    fail(new Error(`MCP server closed (${code ?? signal})\n${stderr}`));
    resolve();
  }));
  const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdout.on('line', line => {
    try {
      const frame = JSON.parse(line);
      assert.equal(frame.jsonrpc, '2.0');
      assert.ok(frame.method || Object.hasOwn(frame, 'id'), 'expected only JSON-RPC on stdout');
      replies.push(frame);
      pending.get(frame.id)?.resolve(frame);
    } catch (error) { invalidOutput ??= error; fail(error); }
  });
  fixture.onCleanup(async () => {
    child.kill('SIGKILL');
    await closed;
    assert.ifError(invalidOutput);
  });

  const send = frame => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  let nextId = 1;
  async function request(method, params, id = nextId++) {
    if (fault) throw fault;
    let timeout;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timeout = setTimeout(() => reject(new Error(`MCP ${method} timed out\n${stderr}`)), requestTimeout);
        send({ id, method, params });
      });
    } finally {
      clearTimeout(timeout);
      pending.delete(id);
    }
  }
  const { result, error } = await request('initialize', {
    protocolVersion: '2025-11-25', clientInfo: { name: 'agy-polish-test', version: '1.0.0' }, capabilities: {}
  });
  assert.equal(error, undefined);
  assert.equal(result.protocolVersion, '2025-11-25');
  assert.equal(typeof result.capabilities.tools, 'object');
  assert.ok(result.serverInfo.name && result.serverInfo.version);
  send({ method: 'notifications/initialized' });
  const call = (args = material, id) => request('tools/call', { name: 'polish_reply', arguments: args }, id);
  const disconnect = () => child.stdin.end();
  return { request, send, call, replies, disconnect };
}

function toolText(frame) {
  assert.ok(Array.isArray(frame.result?.content), JSON.stringify(frame));
  return frame.result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

function fallback(frame) {
  assert.equal(frame.result?.isError ?? false, false);
  assert.equal(toolText(frame), material.draft, 'fallback must preserve the original draft byte for byte');
}

function setMode(fixture, mode, model = null, effort = null) {
  withSettings(fixture, 'await settings.writeSettings(JSON.parse(process.argv[1]));', [JSON.stringify({ mode, model, effort })]);
}

codexTest('native MCP discovery, handshake and stdio round-trip preserve multilingual Markdown', async t => {
  const fixture = isolatedHosts(t, { reply: polished });
  const configuration = ['approval_policy = "on-request"', 'sandbox_mode = "danger-full-access"',
    '[features]', 'hooks = true', 'plugins = true', '[mcp_servers.recursion-fixture]', 'command = "must-not-load"'].join('\n');
  const configFile = join(fixture.profile, 'config.toml');
  write(configFile, configuration);
  const mcp = await connect(fixture);
  const { result } = await mcp.request('tools/list');
  const tool = result.tools.find(item => item.name === 'polish_reply');
  assert.ok(tool, 'polish_reply must be discoverable');
  assert.equal(tool.inputSchema.type, 'object');
  assert.deepEqual([...tool.inputSchema.required].sort(), ['draft', 'question', 'trigger']);
  for (const field of ['draft', 'question', 'trigger']) {
    assert.equal(tool.inputSchema.properties[field].type, 'string');
  }
  assert.deepEqual([...tool.inputSchema.properties.trigger.enum].sort(), ['auto', 'explicit']);
  fallback(await mcp.call({ ...material, trigger: 'auto' }));
  assert.deepEqual(fixture.records(), [], 'a fresh profile must not even start Codex for an ordinary turn');
  const response = await mcp.call(material, 'rewrite/1');
  assert.equal(response.id, 'rewrite/1');
  assert.equal(response.result?.isError ?? false, false);
  assert.equal(toolText(response), polished);
  const runs = execs(fixture);
  assert.equal(runs.length, 1);
  const [{ prompt, args, cwd, profile }] = runs;
  assert.ok(args.includes('-'), 'codex exec reads the rewriting prompt from stdin');
  assert.ok(args.includes('--ephemeral'), 'the child must not save chats in the Codex profile');
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(args.some((arg, index) => arg === '--model' && args[index + 1] === 'gpt-6.2-sol'), JSON.stringify(args));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  for (const override of ['approval_policy="never"', 'features.hooks=false', 'features.plugins=false',
    'model_reasoning_effort="xhigh"']) {
    assert.ok(args.some((arg, index) => arg === override && args[index - 1] === '-c'), JSON.stringify(args));
  }
  assert.notEqual(cwd, fixture.workspace, 'the child must not work directly in the host project');
  assert.notEqual(profile, fixture.profile, 'the editor needs a separate Codex home');
  assert.equal(fs.existsSync(profile), false, 'the editor home must be removed after use');
  assert.equal(fs.readFileSync(configFile, 'utf8'), configuration);
  // Permit a plain prompt or a JSON payload embedded in the prompt.
  for (const content of [material.draft, material.question]) {
    assert.ok(prompt.includes(content) || prompt.includes(JSON.stringify(content).slice(1, -1)), prompt);
    assert.ok(!args.some(arg => arg.includes(content)), 'do not put the question or draft in argv');
  }
  const invalid = await mcp.call({ ...material, trigger: 'unexpected' });
  assert.ok(invalid.error || invalid.result?.isError, JSON.stringify(invalid));
  assert.equal(submissions(fixture), 1);
});

codexTest('MCP rejects fields outside the published tool schema without invoking Codex', async t => {
  const fixture = isolatedHosts(t, { reply: polished });
  const mcp = await connect(fixture);
  const { result } = await mcp.request('tools/list');
  const { inputSchema } = result.tools.find(tool => tool.name === 'polish_reply');
  assert.equal(inputSchema.additionalProperties, false);
  const response = await mcp.call({ ...material, unexpected_field: true });
  assert.deepEqual(fixture.records(), [], 'invalid arguments must not start Codex');
  assert.ok(response.error || response.result?.isError, JSON.stringify(response));
});

codexTest('AgY sends the same stock editing instructions as the Codex role for each trigger', async t => {
  const draft = '系统复用了请求标识。';
  const reply = '系统会用同一个请求编号。';
  const fixture = isolatedHosts(t, { reply });
  const mcp = await connect(fixture);
  const role = fileURLToPath(new URL('../plugins/codex-polish/skills/codex-polish/scripts/editor_role.mjs', import.meta.url));
  for (const [mode, trigger, selected] of [
    ['normal', 'auto'], ['turbo', 'auto'], ['normal', 'explicit'], ['turbo', 'explicit'],
    ['manual', 'explicit'], ['manual', 'explicit', true]
  ]) {
    setMode(fixture, mode);
    write(join(fixture.profile, 'codex-polish/settings/codex-polish.rewrite-mode'), mode === 'turbo' ? 'turbo' : 'normal');
    const rendered = fixture.run(process.execPath, [role, '--cwd', fixture.workspace, '--trigger', trigger]);
    assert.equal(rendered.status, 0, rendered.stderr);
    const instructions = rendered.stdout.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    assert.match(instructions, trigger === 'auto' && mode === 'normal' ? /return it unchanged/ : /Always rewrite `draft`/);

    const args = { question: '为什么不会重复下单？', draft, trigger };
    if (trigger === 'explicit') args.rewrite_request = '说人话';
    if (selected) Object.assign(args, { draft: '上文\n' + draft + '\n下文', selection: draft });
    assert.equal(toolText(await mcp.call(args)), selected ? '上文\n' + reply + '\n下文' : reply);
    const prompt = execs(fixture).at(-1).prompt;
    const split = prompt.lastIndexOf('\n\n');
    assert.equal(prompt.slice(0, split), instructions, `${mode}/${trigger}: instructions sent to Codex differ from the Gemini role`);
    const payload = JSON.parse(prompt.slice(split + 2));
    assert.deepEqual(payload, {
      ...(selected ? {} : { question: args.question }), draft,
      ...(trigger === 'explicit' && { rewrite_request: '说人话' })
    });
  }
});

test('native Codex edits with the selected model and effort through the configured provider and isolated login', {
  skip: !nativeCodex && 'requires the native Codex CLI', timeout: 45_000
}, async t => {
  const fixture = isolatedHosts(t, { codex: false });
  const model = 'offline-fixture-model';
  const selectedModel = 'selected-fixture-model';
  const polishingModel = 'gpt-6.2-sol';
  const route = 'fixture-provider-header-private-value';
  const account = 'fixture-chatgpt-account';
  const jwtPart = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = {
    email: 'fixture@example.test', exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: account }
  };
  const token = `${jwtPart({ alg: 'none' })}.${jwtPart(claims)}.file-fixture`;
  const accessToken = `${jwtPart({ alg: 'none' })}.${jwtPart(claims)}.auto-fixture`;
  const markers = [
    [join(fixture.profile, 'AGENTS.md'), 'profile_agents_canary'],
    [join(fixture.workspace, 'AGENTS.md'), 'caller_agents_canary'],
    [join(fixture.base, 'AGENTS.md'), 'scratch_parent_agents_canary'],
    [join(fixture.profile, 'skills', 'fixture', 'SKILL.md'), 'profile_skill_canary'],
    [join(fixture.home, '.agents', 'skills', 'fixture', 'SKILL.md'), 'user_skill_canary'],
    [join(fixture.base, 'model-instructions.txt'), 'model_instructions_canary']
  ];
  for (const [file, marker] of markers) {
    write(file, file.endsWith('SKILL.md') ? '---\nname: fixture\ndescription: ' + marker + '\n---\n' : marker);
  }
  const inherited = [...markers.map(([, marker]) => marker), 'developer_instructions_canary', 'catalog_instructions_canary'];
  const requests = [], denied = [], socketErrors = [];
  const sockets = new Set();
  const peerDisconnected = error => ['ECONNRESET', 'EPIPE', 'ABORT_ERR'].includes(error.code);
  const provider = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/fixture/responses') {
      denied.push(`${request.method} ${request.url}`);
      response.writeHead(403).end();
      return;
    }
    let body;
    try {
      body = await text(request);
    } catch (error) {
      if (!peerDisconnected(error)) socketErrors.push(error);
      return;
    }
    requests.push({ headers: request.headers, body });
    const message = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify({ reply: polished, complete: true }), annotations: [] }] };
    const result = { id: 'resp_fixture', object: 'response', model: JSON.parse(body).model, status: 'completed', output: [message],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    response.setHeader('content-type', 'text/event-stream');
    for (const [type, fields] of [
      ['response.created', { response: { ...result, status: 'in_progress', output: [] } }],
      ['response.output_item.done', { item: message, output_index: 0 }],
      ['response.completed', { response: result }]
    ]) {
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    }
    response.end();
  });
  provider.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', error => { if (!peerDisconnected(error)) socketErrors.push(error); });
    socket.once('close', () => sockets.delete(socket));
  });
  // The loopback server only serves the fixture route and never forwards proxy traffic.
  provider.on('connect', (request, socket) => {
    denied.push(`CONNECT ${request.url}`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  fixture.onCleanup(async () => {
    await new Promise(resolve => {
      provider.close(resolve);
      // closeAllConnections does not close sockets detached by CONNECT.
      for (const socket of sockets) socket.destroy();
    });
    assert.deepEqual(socketErrors, []);
  });
  const local = `http://127.0.0.1:${provider.address().port}`;
  Object.assign(fixture.env, { HTTP_PROXY: local, HTTPS_PROXY: local, ALL_PROXY: local, NO_PROXY: '127.0.0.1,localhost' });

  const argvLog = join(fixture.base, 'native argv');
  const stderr = join(fixture.base, 'native stderr');
  const profiles = join(fixture.base, 'native profiles');
  let cli = [nativeCodex.command, ...nativeCodex.args];
  if (windows) {
    fixture.env.PATH = [fixture.env.PATH, dirname(nativeCodex.command), process.env.CODEX_INSTALL_DIR,
      process.env.PATH ?? process.env.Path].filter(Boolean).join(delimiter);
  } else {
    const command = cli.map(shellQuote).join(' ');
    const sandbox = '(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:*"))' +
      ' (deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.secd"))';
    const guard = process.platform === 'darwin' ? `/usr/bin/sandbox-exec -p ${shellQuote(sandbox)} ` : '';
    const launcher = join(fixture.env.PATH, 'codex');
    write(launcher, `#!/bin/sh\nprintf '%s\\000' "$@" >> ${shellQuote(argvLog)}\nprintf '%s\\n' "$CODEX_HOME" >> ${shellQuote(profiles)}\nexec ${guard}${command} "$@" 2>> ${shellQuote(stderr)}\n`);
    fs.chmodSync(launcher, 0o755);
    cli = [launcher];
  }
  const runtime = { env: fixture.env, cwd: fixture.workspace, timeout: 22_000 };
  const bundled = await runFile(cli[0], [...cli.slice(1), 'debug', 'models', '--bundled'], { ...runtime, maxBuffer: 8 * 1024 * 1024 });
  const bundledModels = JSON.parse(bundled.stdout).models;
  const template = bundledModels.find(item => item.slug === polishingModel) ?? bundledModels[0];
  const catalog = join(fixture.base, 'models.json');
  write(catalog, JSON.stringify({ models: [model, selectedModel, polishingModel].map(slug => ({
    ...template, slug, display_name: slug, model_messages: null, base_instructions: 'catalog_instructions_canary'
  })) }));

  const hook = join(fixture.base, 'hook ran');
  const mcp = join(fixture.base, 'MCP ran');
  const markerScript = join(fixture.base, 'mark.cjs');
  write(markerScript, 'require("node:fs").writeFileSync(process.argv[2], "started");\n');
  write(join(fixture.profile, 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [
    { type: 'command', command: ['node', markerScript, hook].map(shellQuote).join(' '),
      commandWindows: `node "${markerScript}" "${hook}"` }
  ] }] } }));
  const configPath = join(fixture.profile, 'config.toml');
  const config = `model = ${JSON.stringify(model)}
model_provider = "offline-fixture"
model_catalog_json = "../models.json"
model_reasoning_effort = "low"
developer_instructions = "developer_instructions_canary"
model_instructions_file = "../model-instructions.txt"
cli_auth_credentials_store = "file"
analytics.enabled = false
feedback.enabled = false
features.hooks = true
features.codex_hooks = true
features.plugins = true

[model_providers.offline-fixture]
name = "Offline fixture"
base_url = ${JSON.stringify(local + '/fixture')}
wire_api = "responses"
requires_openai_auth = true
http_headers = { "x-fixture-route" = ${JSON.stringify(route)} }
request_max_retries = 0
stream_max_retries = 0

[mcp_servers.must-not-start]
command = ${JSON.stringify(process.execPath)}
args = ${JSON.stringify([markerScript, mcp])}
`;
  write(configPath, config);
  const authPath = join(fixture.profile, 'auth.json');
  const idToken = `${jwtPart({ alg: 'none' })}.${jwtPart({ email: 'fixture@example.test',
    'https://api.openai.com/auth': { chatgpt_account_id: account } })}.fixture`;
  const auth = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
    tokens: { id_token: idToken, access_token: token, refresh_token: 'fixture-unused-refresh-token', account_id: account } });
  write(authPath, auth);

  const rpc = (method, params) => nativeConfig(method, params, { ...runtime, experimental: true });
  const { data } = await rpc('hooks/list', { cwds: [fixture.workspace] });
  const hookEntry = data.flatMap(entry => entry.hooks).find(entry => entry.command?.includes(markerScript));
  assert.ok(hookEntry?.currentHash, 'the native Codex profile should discover the fixture hook');
  await rpc('config/value/write', { keyPath: `hooks.state.${JSON.stringify(hookEntry.key)}.trusted_hash`,
    value: hookEntry.currentHash, mergeStrategy: 'upsert' });
  const trusted = (await rpc('hooks/list', { cwds: [fixture.workspace] })).data
    .flatMap(entry => entry.hooks).find(entry => entry.key === hookEntry.key);
  assert.equal(trusted?.trustStatus, 'trusted');
  const configured = fs.readFileSync(configPath, 'utf8');

  const diagnostics = () => JSON.stringify({ denied,
    nativeStderr: fs.existsSync(stderr) ? fs.readFileSync(stderr, 'utf8') : '' });
  const { stdout } = await runFile(process.execPath, ['--input-type=module', '-e',
    `import { listModels } from ${JSON.stringify(settingsModule)}; console.log(JSON.stringify(await listModels()));`], runtime);
  assert.ok(JSON.parse(stdout).some(item => item.id === model), `${stdout}\n${diagnostics()}`);
  assert.equal(requests.length, 0, 'listing models must not ask the provider to edit');
  async function assertEdit(client, args, expected) {
    const count = requests.length;
    let reply;
    try {
      reply = toolText(await client.call(args));
    } catch (error) {
      throw new Error(`${expected.scenario}: native Codex edit failed: ${diagnostics()}`, { cause: error });
    }
    assert.equal(requests.length, count + 1, `${expected.scenario}: ${diagnostics()}`);
    assert.equal(reply, expected.reply ?? polished, `${expected.scenario}: ${diagnostics()}`);
    const { headers, body } = requests[count];
    assert.equal(headers.authorization, `Bearer ${expected.token ?? token}`);
    assert.equal(headers['x-fixture-route'], route);
    const payload = JSON.parse(body);
    assert.equal(payload.model, expected.model, expected.scenario);
    assert.equal(payload.reasoning?.effort, expected.effort, expected.scenario);
    assert.deepEqual(payload.tools ?? [], []);
    for (const marker of [...inherited, ...(expected.excluded ?? [])]) assert.ok(!body.includes(marker), marker);
    return payload;
  }

  const preferences = join(fixture.reverseSettings, 'settings.json');
  const client = await connect(fixture, { requestTimeout: 10_000 });
  try {
    assert.ok(!fs.existsSync(preferences));
    fallback(await client.call({ ...material, trigger: 'auto' }));
    assert.equal(requests.length, 0, 'manual mode must not send the draft to the provider on an ordinary turn');
    const payload = await assertEdit(client, material, {
      scenario: 'missing preferences', model: polishingModel, effort: 'xhigh'
    });
    assert.ok(payload.input.some(item => item.content?.some(part => part.text?.includes(material.question))));

    write(preferences, JSON.stringify({ mode: 'normal', model: null, effort: null }));
    await assertEdit(client, { ...material, trigger: 'auto' },
      { scenario: 'saved normal mode', model: polishingModel, effort: 'xhigh' });

    setMode(fixture, 'normal', selectedModel, 'medium');
    await assertEdit(client, material, { scenario: 'explicit model and effort', model: selectedModel, effort: 'medium' });

    setMode(fixture, 'normal', selectedModel, null);
    await assertEdit(client, material, { scenario: 'explicit model with native effort', model: selectedModel, effort: 'low' });
  } finally {
    client.disconnect();
  }
  assert.equal(fs.existsSync(hook), false);
  assert.equal(fs.existsSync(mcp), false);
  assert.equal(fs.readFileSync(configPath, 'utf8'), configured);
  assert.equal(fs.readFileSync(authPath, 'utf8'), auth);

  // Codex resolves auto storage in the original home and hands the editor only an access token.
  const autoCredential = JSON.parse(auth);
  autoCredential.tokens.access_token = accessToken;
  const autoAuth = JSON.stringify(autoCredential);
  const autoConfig = configured.replace('cli_auth_credentials_store = "file"', 'cli_auth_credentials_store = "auto"');
  write(configPath, autoConfig);
  write(authPath, autoAuth);
  const bridgeClient = await connect(fixture, { requestTimeout: 10_000 });
  const prefix = 'outside_selection_before_canary\n\n', suffix = '\n\noutside_selection_after_canary';
  try {
    fs.rmSync(preferences);
    await assertEdit(bridgeClient, material, {
      scenario: 'missing preferences via ChatGPT bridge', model: polishingModel, effort: 'xhigh', token: accessToken
    });

    setMode(fixture, 'normal', 'codex-default', 'codex-default');
    await assertEdit(bridgeClient, {
      question: 'outside_selection_question_canary', draft: prefix + material.draft + suffix,
      selection: material.draft, trigger: 'explicit'
    }, {
      scenario: 'follow Codex via ChatGPT bridge', model, effort: 'low', token: accessToken,
      reply: prefix + polished + suffix, excluded: ['outside_selection_']
    });
  } finally {
    bridgeClient.disconnect();
  }
  assert.equal(fs.readFileSync(configPath, 'utf8'), autoConfig);
  assert.equal(fs.readFileSync(authPath, 'utf8'), autoAuth);
  if (!windows) {
    const argv = fs.readFileSync(argvLog, 'utf8').split('\0');
    assert.ok(argv.includes('exec'), JSON.stringify(argv));
    const execArgs = argv.slice(argv.indexOf('exec'));
    for (const setting of ['features.hooks=false', 'features.codex_hooks=false', 'features.plugins=false']) {
      assert.ok(execArgs.includes(setting), JSON.stringify(execArgs));
    }
    const nativeStderr = fs.readFileSync(stderr, 'utf8');
    for (const value of [route, token, idToken, accessToken, material.question, '原始答案', local]) {
      assert.ok(!argv.some(arg => arg.includes(value)), 'private provider and draft data must stay out of argv');
      assert.ok(!nativeStderr.includes(value), 'private provider and draft data must stay out of logs');
    }
    const editorHomes = fs.readFileSync(profiles, 'utf8').trim().split('\n').filter(home => home !== fixture.profile);
    assert.equal(new Set(editorHomes).size, requests.length);
    assert.ok(editorHomes.every(home => !fs.existsSync(home)), 'private editor homes must be cleaned up');
  }
});

test('MCP never uses stdout or partial output after a missing, empty or failed Codex run', async t => {
  for (const scenario of ['missing-cli', 'no-file', 'empty', 'nonzero', 'permission-denied', 'incomplete', 'truncated']) {
    await t.test(scenario, { skip: windows && scenario !== 'missing-cli' && 'requires POSIX fake codex executable' }, async t => {
      const fixture = isolatedHosts(t, { scenario, codex: scenario !== 'missing-cli', reply: polished });
      const mcp = await connect(fixture);
      fallback(await mcp.call());
      assert.equal(submissions(fixture), scenario === 'missing-cli' ? 0 : 1, 'failed requests must not resubmit');
    });
  }
});

codexTest('MCP stops active Codex on cancellation or disconnect without publishing unfinished output', async t => {
  for (const disconnect of [false, true]) {
    await t.test(disconnect ? 'stdio disconnect' : 'MCP cancellation notification', async t => {
      const fixture = isolatedHosts(t, { scenario: 'cancel', reply: polished });
      const mcp = await connect(fixture);
      const requestId = 'cancel/rewrite';
      mcp.send({ id: requestId, method: 'tools/call', params: { name: 'polish_reply', arguments: material } });
      const run = await until(() => execs(fixture)[0], 'Codex did not read the prompt and stage output');
      fixture.onCleanup(() => { if (alive(run.pid)) process.kill(run.pid, 'SIGKILL'); });
      if (disconnect) mcp.disconnect();
      else mcp.send({ method: 'notifications/cancelled', params: { requestId, reason: 'fixture cancellation' } });
      await until(() => !alive(run.pid), 'interruption left Codex running');
      if (!disconnect) assert.deepEqual((await mcp.request('ping')).result, {});
      const responses = mcp.replies.filter(frame => frame.id === requestId);
      assert.ok(responses.length <= 1, 'at most one response per request');
      for (const frame of responses) fallback(frame);
      assert.equal(submissions(fixture), 1);
    });
  }
});

codexTest('the ChatGPT bridge cleans up a one-shot app-server and requires a completed reply', async t => {
  for (const scenario of ['complete', 'incomplete', 'exits-early', 'cancelled']) {
    await t.test(scenario, async t => {
      const fixture = isolatedHosts(t, { scenario, reply: polished });
      const script = join(fixture.base, 'one-shot-fixture.mjs');
      const pidFile = join(fixture.base, 'editor-pid');
      const stopped = join(fixture.base, 'editor-stopping');
      write(script, `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const { CODEX_HOME, POLISH_TEST_REPLY, POLISH_TEST_SCENARIO } = process.env;
const write = message => process.stdout.write(JSON.stringify(message) + '\\n');
const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-workspace' } })).toString('base64url');
const token = 'fixture.' + claims + '.fixture';
const responses = {
  'initialize': { codexHome: CODEX_HOME },
  'config/read': { config: { cli_auth_credentials_store: 'keyring' } },
  'getAuthStatus': { authMethod: 'chatgpt', authToken: token },
  'account/login/start': {},
  'thread/start': { thread: { id: 'thread' }, modelProvider: 'openai' },
  'turn/start': { turn: { id: 'turn' } }
};
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (id === undefined) continue;
  write({ id, result: responses[method] });
  if (method !== 'turn/start') continue;
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  write({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn',
    item: { type: 'agentMessage', text: JSON.stringify({ reply: POLISH_TEST_REPLY,
      complete: POLISH_TEST_SCENARIO !== 'incomplete' }) } } });
  if (POLISH_TEST_SCENARIO === 'exits-early') {
    process.stdin.destroy();
    process.exitCode = 12;
    break;
  }
  process.on('SIGTERM', () => writeFileSync(${JSON.stringify(stopped)}, ''));
  setInterval(() => {}, 1000);
  write({ method: 'turn/completed', params: { threadId: 'thread',
    turn: { id: 'turn', status: 'completed' } } });
}
`);
      const cli = join(fixture.env.PATH, 'codex');
      write(cli, '#!/bin/sh\nexec ' + [process.execPath, script].map(shellQuote).join(' ') + ' "$@"\n');
      fs.chmodSync(cli, 0o755);
      const pid = () => fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
      fixture.onCleanup(() => { if (pid() && alive(pid())) process.kill(pid(), 'SIGKILL'); });
      const mcp = await connect(fixture, { requestTimeout: 3000 });
      if (scenario === 'cancelled') {
        const requestId = 'cancel-bridge';
        mcp.send({ id: requestId, method: 'tools/call', params: { name: 'polish_reply', arguments: material } });
        await until(() => fs.existsSync(stopped), 'completed app-server was not stopped');
        mcp.send({ method: 'notifications/cancelled', params: { requestId } });
        await until(() => !alive(pid()), 'cancelled app-server is still running');
        assert.deepEqual((await mcp.request('ping')).result, {});
        for (const result of mcp.replies.filter(frame => frame.id === requestId)) fallback(result);
      } else {
        const result = await mcp.call();
        if (scenario === 'complete') assert.equal(toolText(result), polished);
        else fallback(result);
        assert.ok(pid());
        assert.equal(alive(pid()), false);
      }
    });
  }
});

codexTest('reverse settings gate automatic/manual dispatch, and model and effort reach Codex exec', async t => {
  const fixture = isolatedHosts(t, { reply: polished });
  const forward = join(fixture.profile, 'codex-polish', 'settings', 'codex-polish.mode');
  write(forward, 'off\n');
  setMode(fixture, 'manual', 'fixture-model', 'xhigh');
  const mcp = await connect(fixture);
  fallback(await mcp.call({ ...material, trigger: 'auto' }));
  assert.equal(submissions(fixture), 0);
  assert.equal(toolText(await mcp.call(material)), polished);
  const [{ args }] = execs(fixture);
  assert.ok(args.includes('fixture-model') || args.some(arg => /(?:^--model=|^model=).?fixture-model/.test(arg)), JSON.stringify(args));
  assert.ok(args.some(arg => arg.includes('xhigh')), JSON.stringify(args));
  setMode(fixture, 'off');
  fallback(await mcp.call({ ...material, trigger: 'auto' }));
  fallback(await mcp.call(material));
  assert.equal(submissions(fixture), 1);
  assert.equal(fs.readFileSync(forward, 'utf8'), 'off\n');
});

codexTest('the editor applies settings changed during provider lookup', async t => {
  for (const mode of ['off', 'manual', 'turbo']) {
    await t.test(mode, async t => {
      const fixture = isolatedHosts(t, { reply: polished });
      const launcher = join(fixture.env.PATH, 'codex');
      const original = launcher + '-fixture';
      const started = join(fixture.base, 'lookup-started');
      const release = join(fixture.base, 'lookup-release');
      fs.renameSync(launcher, original);
      write(launcher, [
        '#!/bin/sh',
        'if [ "$1" = app-server ]; then',
        '  : > ' + shellQuote(started),
        '  while [ ! -f ' + shellQuote(release) + ' ]; do /bin/sleep 0.025; done',
        'fi',
        'exec ' + shellQuote(original) + ' "$@"',
        ''
      ].join('\n'));
      fs.chmodSync(launcher, 0o755);
      setMode(fixture, 'normal', 'old-model', 'low');
      const mcp = await connect(fixture);
      const response = mcp.call({ ...material, trigger: mode === 'manual' ? 'explicit' : 'auto' });
      try {
        await until(() => fs.existsSync(started), 'provider lookup did not start');
        setMode(fixture, mode, 'latest-model', 'xhigh');
      } finally {
        write(release, '');
      }
      const result = await response;
      if (mode === 'turbo') {
        assert.equal(toolText(result), polished);
        const [{ args }] = execs(fixture);
        assert.ok(args.includes('latest-model'));
        assert.ok(args.includes('model_reasoning_effort="xhigh"'));
      } else {
        fallback(result);
        assert.equal(submissions(fixture), 0);
      }
    });
  }
});

codexTest('an explicit privacy opt-out suppresses Codex even in Turbo mode', async t => {
  const fixture = isolatedHosts(t, { reply: polished });
  setMode(fixture, 'turbo');
  const mcp = await connect(fixture);
  const question = '请用中文解释。不要把草稿外传。不要调用 Codex。';
  fallback(await mcp.call({ ...material, question, trigger: 'auto' }));
  fallback(await mcp.call({ ...material, question }));
  assert.equal(submissions(fixture), 0);
});

codexTest('a complete-looking rewrite that changes fenced code falls back to the original', async t => {
  const fixture = isolatedHosts(t, { reply: polished.replace('const 原文', 'const 被修改') });
  const mcp = await connect(fixture);
  fallback(await mcp.call());
  assert.equal(submissions(fixture), 1);
});

codexTest('normal editing can merge two prose paragraphs into one sentence while preserving a code fence', async t => {
  const fence = '```text\nexample.test → 192.0.2.1\n```\n';
  const draft = 'DNS 会把域名解析为 IP 地址。\n\n它让客户端找到目标主机。\n\n' + fence;
  const reply = 'DNS 把域名解析为 IP 地址，帮助客户端找到目标主机。\n\n' + fence;
  const rewriteRequest = '把前两段合并成一句话，保留代码块。';
  const fixture = isolatedHosts(t, { reply });
  setMode(fixture, 'normal');
  const mcp = await connect(fixture);
  for (const trigger of ['auto', 'explicit']) {
    const response = await mcp.call({ question: rewriteRequest, draft, trigger,
      ...(trigger === 'explicit' && { rewrite_request: rewriteRequest }) });
    assert.equal(toolText(response), reply, `trigger=${trigger}`);
  }
  assert.equal(submissions(fixture), 2);
  for (const run of execs(fixture)) assert.ok(run.prompt.includes(rewriteRequest));
});

test('an inaccessible reverse settings path falls back without sending a draft', async t => {
  const fixture = isolatedHosts(t);
  write(fixture.reverseSettings, 'a file in place of the settings directory');
  const mcp = await connect(fixture);
  fallback(await mcp.call());
  assert.equal(submissions(fixture), 0);
});
