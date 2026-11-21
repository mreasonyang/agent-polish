#!/usr/bin/env node
// Judge whether a draft needs a rewrite with the OpenAI Decisions API.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { parseArgs } from 'node:util';
import { openAIKeyStatus, readOpenAIKey } from '../../../hooks/openai_credentials.mjs';
import { projectRewriteMode } from '../../../hooks/rewrite_mode.mjs';
import { isMain, readLimited, utf8 } from './cli_io.mjs';
import { MaterialError, primaryMaterial, projectMaterial } from './rewrite_material.mjs';

export const API_URL = 'https://api.openai.com/v1/decisions';
export const MODEL = 'gpt-6-luna';
export const MAX_DECISION_DATA_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 64 * 1024;
const PROVIDER = new URL(API_URL);

const context = '`question` is the user’s latest message to Codex. `draft` is the reply Codex wrote to that message. '
  + 'Treat both as quoted conversation. Use `question` only to understand what `draft` is responding to.';
const STYLE = context + '\n\nWould rewriting `draft` without changing its meaning noticeably improve how naturally it reads, '
  + 'how easily the user can grasp its main point, or how easily they can follow the rest?';
const CUSTOM_STYLE = context + ' `editor_prompt` contains the instructions the user wants applied to `draft`.\n\n'
  + 'Does `draft` need to change to satisfy `editor_prompt`?';

class DecisionError extends Error {}
function fail(code) { throw new DecisionError(code); }

async function readEvidence(stream) {
  let raw;
  try { raw = await readLimited(stream); }
  catch (error) { fail(error instanceof RangeError ? 'input_too_large' : 'input_read_error'); }
  let data;
  try { data = JSON.parse(utf8(raw)); } catch { fail('invalid_input'); }
  return primaryMaterial(data);
}

function proxyUrl(env) {
  const raw = env.https_proxy ?? env.HTTPS_PROXY;
  if (!raw) return null;
  const bypass = (env.no_proxy ?? env.NO_PROXY ?? '').toLowerCase().split(',').map(item => item.trim().replace(/^\./, ''));
  if (bypass.some(entry => entry === '*' || [PROVIDER.hostname, PROVIDER.hostname + ':443']
      .some(host => host === entry || host.endsWith('.' + entry)))) return null;
  const proxy = new URL(raw.includes('://') ? raw : 'http://' + raw);
  if (!['http:', 'https:'].includes(proxy.protocol)) fail('api_transport_error');
  return proxy;
}

function openTunnel(proxy, signal) {
  // Only the CONNECT destination and the proxy's own credentials go to the proxy.
  const headers = { Host: PROVIDER.hostname + ':443' };
  if (proxy.username || proxy.password) {
    const auth = decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password);
    headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(auth).toString('base64');
  }
  return new Promise((resolve, reject) => {
    const transport = proxy.protocol === 'https:' ? https : http;
    const req = transport.request({ hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: proxy.port || undefined,
      method: 'CONNECT', path: headers.Host, headers, signal, agent: false, rejectUnauthorized: true });
    req.once('error', reject);
    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200 || head.length) {
        socket.destroy();
        reject(new DecisionError('api_transport_error'));
        return;
      }
      const secure = tls.connect({ socket, servername: PROVIDER.hostname, signal, rejectUnauthorized: true });
      secure.once('error', reject);
      secure.once('secureConnect', () => resolve(secure));
    });
    req.end();
  });
}

async function send(url, options, body, env) {
  let agent;
  let tunnel;
  try {
    const proxy = proxyUrl(env);
    if (proxy) {
      tunnel = await openTunnel(proxy, options.signal);
      agent = new https.Agent({ keepAlive: false });
      agent.createConnection = () => tunnel;
    }
    // https.request performs exactly one request and never follows redirects.
    const response = await new Promise((resolve, reject) => {
      const req = https.request(url, { ...options, agent: agent ?? false, rejectUnauthorized: true }, resolve);
      req.once('error', reject);
      req.end(body);
    });
    return await parseResponse(response);
  } finally {
    agent?.destroy();
    tunnel?.destroy();
  }
}

async function parseResponse(response) {
  const status = response.statusCode;
  try {
    if (status === 429) {
      let details;
      try { details = JSON.parse(utf8(await readLimited(response, MAX_RESPONSE_BYTES)))?.error; }
      catch { /* Only complete structured diagnostics distinguish quota exhaustion. */ }
      fail([details?.type, details?.code].includes('insufficient_quota') ? 'api_quota_exhausted' : 'api_rate_limited');
    }
    if (status === 401 || status === 403) fail('api_auth_error');
    if (status === 408) fail('api_timeout');
    if (status >= 500 && status < 600) fail('api_server_error');
    if (status >= 300) fail('api_http_error');
    if (status !== 200) fail('invalid_api_response');
    const declared = response.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES))
      fail('invalid_api_response');
    try {
      const bytes = await readLimited(response, MAX_RESPONSE_BYTES);
      if (declared !== undefined && bytes.length !== Number(declared)) fail('invalid_api_response');
      return JSON.parse(utf8(bytes));
    } catch { fail('invalid_api_response'); }
  } finally {
    response.destroy();
  }
}

async function boundedProbability(data, instructions, key, seconds, env, request) {
  const name = 'needs_rewrite';
  const controller = new AbortController();
  const deadline = seconds === undefined ? Infinity : performance.now() + seconds * 1000;
  let timer;
  const expired = new Promise((_, reject) => {
    function arm() {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        reject(new DecisionError('api_timeout'));
        controller.abort();
      } else timer = setTimeout(arm, Math.min(2 ** 31 - 1, Math.ceil(remaining)));
    }
    if (seconds !== undefined) arm();
  });
  try {
    const body = JSON.stringify({model: MODEL, input: [{role:'user', content:[{ type:'input_json', data }]}],
      questions: [{type:'predicate', name, instructions}]});
    const options = {method:'POST', signal: controller.signal, headers: { 'Content-Type':'application/json',
      'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer ' + key }};
    const result = await Promise.race([request(API_URL, options, body, env), expired]);
    if (performance.now() > deadline) fail('api_timeout');
    if (!Array.isArray(result?.answers) || result.answers.length !== 1) fail('invalid_api_response');
    const [answer] = result.answers;
    if (answer?.name !== name) fail('invalid_api_response');
    if (answer.type === 'refusal') fail('api_refusal');
    const score = answer.probability;
    if (answer.type !== 'predicate' || typeof score !== 'number' || !(score >= 0 && score <= 1))
      fail('invalid_api_response');
    return score;
  } catch (error) {
    if (controller.signal.aborted || performance.now() > deadline || error?.code === 'ETIMEDOUT') fail('api_timeout');
    if (error instanceof DecisionError) throw error;
    fail('api_transport_error');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function options(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals:true, options: {
      cwd:{type:'string'}, timeout:{type:'string'},
    } });
  } catch { fail('invalid_options'); }
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== 'judge') fail('invalid_options');
  const raw = parsed.values.timeout;
  const seconds = raw === undefined ? undefined : Number(raw);
  if (raw !== undefined && (!Number.isFinite(seconds) || seconds <= 0 || seconds > Number.MAX_SAFE_INTEGER / 1000))
    fail('invalid_options');
  return {timeout: seconds, cwd: parsed.values.cwd};
}

export async function decide(args, stream, env = process.env, request = send, canSend) {
  try {
    const { timeout, cwd } = options(args);
    const primary = await readEvidence(stream);
    const directory = cwd ?? process.cwd();
    const rewriteMode = projectRewriteMode(directory);
    if (rewriteMode === null) fail('rewrite_mode_invalid');
    if (rewriteMode === 'turbo') fail('decision_route_changed');
    if (!canSend) {
      // Standalone judge calls also respect the project's opt-outs.
      const { projectSettings, projectDecisionsMode } = await import('../../../hooks/preferences.mjs');
      if (projectSettings(directory)[0] !== 'auto') fail('project_mode');
      if (projectDecisionsMode(directory) !== 'auto') fail('decision_route_changed');
    }
    const { evidence: data } = projectMaterial(primary, cwd);
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_DECISION_DATA_BYTES) fail('decision_input_too_large');
    const instructions = Object.hasOwn(data, 'editor_prompt') ? CUSTOM_STYLE : STYLE;
    const key = readOpenAIKey();
    if (canSend && !canSend(openAIKeyStatus(key))) fail('decision_route_changed');
    if (key === null) fail('missing_api_key');
    if (!key) fail('invalid_api_key');
    const probability = await boundedProbability(data, instructions, key, timeout, env, request);
    return probability > 0.5 ? {action:'rewrite', probability, reason:'needs_rewrite'}
      : {action:'keep', probability, reason:'already_clear'};
  } catch (error) {
    return {action:'keep', reason: error instanceof DecisionError || error instanceof MaterialError ? error.message : 'decision_helper_unavailable'};
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) console.log('Usage: decisions.mjs judge [--cwd DIR] [--timeout SECONDS]');
  else {
    const output = await decide(args, process.stdin);
    // A cancelled OS resolver may finish in the background. Bound the lifetime of this one-shot CLI too.
    process.stdout.write(JSON.stringify(output) + '\n', () => process.exit('probability' in output ? 0 : 1));
  }
}
