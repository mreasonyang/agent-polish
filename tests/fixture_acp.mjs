#!/usr/bin/env node
// Offline ACP agent for tests. Reads stdin, writes stdout, runs no tools.
import { createInterface } from 'node:readline';
import { isAbsolute } from 'node:path';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { isMain, record } from '../plugins/codex-polish/skills/codex-polish/scripts/cli_io.mjs';

export const SESSION = 'fixture-session';
export const PERMISSION_ID = 'fixture-permission';
export const REPLY = ['我改了判断会话过期的逻辑。', '已有的会话还能不能用，我还没验证。'];
const SCENARIOS = ['ok','permission','permission-then-text','truncated','signed-out','auth-denied','no-hydrogen',
  'model-drift','stalled','cancelled','refused','provider-error','interleaved','wrong-end-id','nontext'];

export function selectOption(id, category, name, currentValue, choices) {
  return {id, category, name, type:'select', currentValue, options:choices.map(([value, name]) => ({value, name}))};
}

export class Fixture {
  constructor(scenario, write = data => process.stdout.write(data)) {
    this.scenario = scenario;
    this.write = write;
    this.initialized = false;
    this.authenticated = !['signed-out','auth-denied'].includes(scenario);
    this.hasSession = false;
    this.model = 'gemini-3.8-flash';
    this.thinking = 'high';
    this.pending = null;
    this.ended = false;
  }

  emit(fields) { this.write(JSON.stringify({jsonrpc:'2.0', ...fields}) + '\n'); }
  error(id, message, code = -32602) { this.emit({id, error:{code, message}}); }
  update(sessionId, sessionUpdate, fields) {
    this.emit({method:'session/update', params:{sessionId, update:{sessionUpdate, ...fields}}});
  }

  options() {
    const models = [['gemini-3.8-flash','Gemini 3.8 Flash']];
    if (this.scenario !== 'no-hydrogen') models.push(['gemini-4-hydrogen', 'Gemini 4 Hydrogen']);
    const options = [selectOption('model','model','Model',this.model,models)];
    if (this.model === 'gemini-4-hydrogen') options.push(selectOption('thought_level','thought_level','Thinking level',
      this.thinking,[['high','High'],['low','Low']]));
    return options;
  }

  stop(stopReason) {
    if (this.pending === null) return;
    this.emit({id:this.pending, result:{stopReason}});
    this.pending = null;
  }

  permissionReply(message) {
    if (this.pending === null || message.id !== PERMISSION_ID) return;
    if ([{outcome:'cancelled'}, {outcome:'selected', optionId:'reject-once'}].some(
      outcome => isDeepStrictEqual(outcome, message.result?.outcome))) {
      if (this.scenario === 'permission-then-text') {
        this.update(SESSION, 'agent_message_chunk', {content:{type:'text', text:REPLY[1]}});
        this.stop('end_turn');
      } else this.stop('cancelled');
    } else {
      this.error(this.pending, 'The fixture requires a denied or cancelled permission.');
      this.pending = null;
    }
  }

  prompt(id, params) {
    if (!Array.isArray(params.prompt) || !params.prompt.some(block => block?.type === 'text' && block.text))
      return this.error(id, 'Expected at least one text prompt block.');
    if (this.pending !== null) return this.error(id, 'A turn is already running.');
    this.pending = id;
    if (this.scenario === 'permission' || this.scenario === 'permission-then-text') {
      if (this.scenario === 'permission-then-text')
        this.update(SESSION, 'agent_message_chunk', {content:{type:'text', text:REPLY[0]}});
      this.emit({id:PERMISSION_ID, method:'session/request_permission', params:{
        sessionId:SESSION, toolCall:{toolCallId:'fixture-tool', title:'Simulated read', kind:'read'},
        options:[{optionId:'allow-once', name:'Allow', kind:'allow_once'}, {optionId:'reject-once', name:'Deny', kind:'reject_once'}],
      }});
      return;
    }
    this.update(SESSION, 'agent_message_chunk', {content:{type:'text', text:REPLY[0]}});
    switch (this.scenario) {
      case 'truncated':
        this.write('{"jsonrpc":"2.0","id":');
        this.ended = true;
        return;
      case 'stalled': return;
      case 'cancelled': return this.stop('cancelled');
      case 'refused': return this.stop('refusal');
      case 'provider-error':
        this.error(id, 'Simulated provider failure.', -32603);
        this.pending = null;
        return;
      case 'model-drift':
        this.model = 'gemini-3.8-flash';
        this.update(SESSION, 'config_option_update', {configOptions:this.options()});
        break;
      case 'interleaved':
        this.update('other-session','agent_message_chunk',{content:{type:'text', text:'另一个会话'}});
        this.update(SESSION,'agent_thought_chunk',{content:{type:'text', text:'不可交付的思考'}});
        break;
      case 'nontext':
        this.update(SESSION,'agent_message_chunk',{content:{type:'image', mimeType:'image/png', data:'AA=='}});
        break;
    }
    this.update(SESSION, 'agent_message_chunk', {content:{type:'text', text:REPLY[1]}});
    if (this.scenario === 'wrong-end-id') {
      this.emit({id:'another-request', result:{stopReason:'end_turn'}});
      this.ended = true;
    } else this.stop('end_turn');
  }

  handle(message) {
    const {id, method, params = {}} = message;
    if (method == null) return this.permissionReply(message);
    if (method === 'session/cancel' && params.sessionId === SESSION) return this.stop('cancelled');
    if (id == null) return;
    if (method === 'initialize') {
      if (params.protocolVersion !== 1) return this.error(id, 'Expected protocolVersion 1.');
      this.initialized = true;
      return this.emit({id, result:{protocolVersion:1, agentCapabilities:{},
        authMethods:[{id:'gemini-api-key', name:'Simulated API key'}, {id:'agent-platform', name:'Simulated Agent Platform'}],
        agentInfo:{name:'offline-fixture', version:'1.0'}}});
    }
    if (!this.initialized) return this.error(id, 'Initialize first.');
    if (method === 'authenticate') {
      if (!['gemini-api-key','agent-platform'].includes(params.methodId)) return this.error(id, 'Unknown fixture authentication method.');
      if (this.scenario === 'auth-denied') return this.error(id, 'Simulated authentication failure.', -32000);
      this.authenticated = true;
      return this.emit({id, result:{}});
    }
    if (!this.authenticated) return this.error(id, 'Authentication required', -32000);
    if (method === 'session/new') {
      if (this.hasSession || !isAbsolute(params.cwd ?? '') || !isDeepStrictEqual(params.mcpServers, []))
        return this.error(id, 'Expected one new session with absolute cwd and empty mcpServers.');
      this.hasSession = true;
      return this.emit({id, result:{sessionId:SESSION, configOptions:this.options()}});
    }
    if (!this.hasSession || params.sessionId !== SESSION) return this.error(id, 'Unknown session.');
    if (method === 'session/set_config_option') {
      const option = this.options().find(item => item.id === params.configId);
      if (!option?.options.some(item => item.value === params.value)) return this.error(id, 'Unknown config option or value.');
      if (params.configId === 'model') this.model = params.value;
      else this.thinking = params.value;
      return this.emit({id, result:{configOptions:this.options()}});
    }
    if (method === 'session/prompt') return this.prompt(id, params);
    this.error(id, 'Unsupported fixture method.', -32601);
  }
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({options:{scenario:{type:'string', default:'ok'}, help:{type:'boolean', short:'h'}}});
  if (values.help) console.log('Usage: fixture_acp.mjs [--scenario ' + SCENARIOS.join('|') + ']');
  else if (!SCENARIOS.includes(values.scenario)) process.exitCode = 2;
  else {
    const fixture = new Fixture(values.scenario);
    for await (const line of createInterface({input:process.stdin, crlfDelay:Infinity})) {
      let message;
      try { message = JSON.parse(line); }
      catch { fixture.error(null, 'Invalid JSON.', -32700); continue; }
      if (!record(message) || message.jsonrpc !== '2.0') fixture.error(null, 'Invalid JSON-RPC envelope.', -32600);
      else fixture.handle(message);
      if (fixture.ended) { process.stdin.destroy(); break; }
    }
  }
}
