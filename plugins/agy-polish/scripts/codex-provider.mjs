import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { configArguments, startCodex } from './codex-process.mjs';

export const isolation = [
  'project_root_markers=[]',
  'project_doc_max_bytes=0',
  'features.hooks=false',
  'features.codex_hooks=false',
  'features.plugins=false',
  'features.apps=false'
];

export const privateLogging = [
  'analytics.enabled=false',
  'feedback.enabled=false',
  'otel.exporter="none"',
  'otel.trace_exporter="none"',
  'otel.metrics_exporter="none"',
  'otel.log_user_prompt=false'
];

export function noDiagnosticLog(cwd) {
  return 'log_dir=' + JSON.stringify(join(dirname(cwd), 'no-logs'));
}

export async function withCodexAppServer(cwd, {
  signal, timeout, env, overrides = [], experimental = false, explicitGatewayOauth = false, oneShot = false
}, operation) {
  const args = ['app-server', '--stdio', ...configArguments([...isolation, ...overrides])];
  const { child, closed, stop } = startCodex(args, cwd, { signal, timeout, env, captureOutput: true });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responses = lines[Symbol.asyncIterator]();
  let requestId = 0;

  function send(frame) {
    child.stdin.write(JSON.stringify(frame) + '\n');
  }

  async function receive() {
    const { value, done } = await responses.next();
    if (done) throw new Error('Codex app-server closed');
    return JSON.parse(value);
  }

  async function request(method, params, onMessage) {
    const id = ++requestId;
    send({ id, method, params });
    for (;;) {
      const message = await receive();
      if (message.method || message.id !== id) {
        await onMessage?.(message);
        continue;
      }
      if (message.error || !message.result) break;
      return message.result;
    }
    throw new Error('Codex configuration or model catalog unavailable');
  }

  try {
    const { codexHome } = await request('initialize', {
      clientInfo: { name: 'agy-polish', version: '1' },
      capabilities: { experimentalApi: experimental, explicitGatewayOauth }
    });
    send({ method: 'initialized' });
    return await operation(request, { codexHome, receive, send });
  } finally {
    lines.close();
    // A completed turn can leave Codex waiting on unrelated background work after EOF.
    if (oneShot) {
      stop();
      child.stdout.destroy();
    } else {
      child.stdin.end();
    }
    if (!await closed || signal?.aborted) throw new Error('Codex app-server unavailable');
  }
}

const routingSettings = [
  'model_provider', 'model', 'model_reasoning_effort', 'model_catalog_json',
  'openai_base_url', 'chatgpt_base_url', 'forced_login_method', 'forced_chatgpt_workspace_id'
];

function withNativeProfile(cwd, options, operation) {
  return withCodexAppServer(cwd, {
    ...options,
    explicitGatewayOauth: true,
    overrides: [
      ...privateLogging,
      noDiagnosticLog(cwd),
      'sqlite_home=' + JSON.stringify(join(dirname(cwd), 'lookup-state'))
    ]
  }, operation);
}

export function loadCodexProvider(cwd, options) {
  return withNativeProfile(cwd, options, async (request, { codexHome }) => {
    const { config } = await request('config/read', { includeLayers: false, cwd });
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('Codex provider configuration unavailable');
    }
    const settings = Object.fromEntries(routingSettings.filter((key) => config[key] != null)
      .map((key) => [key, config[key]]));
    const provider = settings.model_provider ?? 'openai';
    if (typeof provider !== 'string' || !provider) throw new Error('Invalid Codex provider');
    const definition = Object.hasOwn(config.model_providers ?? {}, provider) ? config.model_providers[provider] : null;
    if (definition) settings.model_providers = { [provider]: definition };
    const store = config.cli_auth_credentials_store ?? 'file';
    const requiresOpenaiAuth = provider === 'openai' || definition?.requires_openai_auth === true;
    let auth;
    if (['keyring', 'auto'].includes(store) && requiresOpenaiAuth &&
        !process.env.CODEX_ACCESS_TOKEN?.trim() &&
        !(process.env.CODEX_API_KEY?.trim() && settings.forced_login_method !== 'chatgpt')) {
      auth = await getNativeAuth(request);
    }
    return { settings, codexHome, store, requiresOpenaiAuth, auth };
  });
}

async function getNativeAuth(request, refreshToken = false) {
  const { authMethod, authToken } = await request('getAuthStatus', { includeToken: true, refreshToken });
  if (typeof authToken !== 'string' || !authToken) throw new Error('Native Codex credentials unavailable');
  if (authMethod === 'apikey') return { apiKey: authToken };
  if (authMethod === 'chatgpt' || authMethod === 'chatgptAuthTokens') {
    // Codex's OAuth access token carries the workspace used by the Responses API.
    const claims = JSON.parse(Buffer.from(authToken.split('.')[1], 'base64url').toString('utf8'));
    const chatgptAccountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    if (typeof chatgptAccountId === 'string' && chatgptAccountId) {
      return { accessToken: authToken, chatgptAccountId };
    }
  }
  throw new Error('Unsupported native Codex credentials');
}

export function readNativeAuth(cwd, options, accountToRefresh) {
  return withNativeProfile(cwd, options, async (request) => {
    const auth = await getNativeAuth(request);
    if (!accountToRefresh) return auth;
    if (auth.chatgptAccountId !== accountToRefresh) throw new Error('Native Codex account changed');
    const fresh = await getNativeAuth(request, true);
    if (fresh.chatgptAccountId !== accountToRefresh) throw new Error('Native Codex account changed');
    return fresh;
  });
}
