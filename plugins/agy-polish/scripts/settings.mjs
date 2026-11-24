import { randomUUID } from 'node:crypto';
import {
  mkdirSync, readFileSync, renameSync, rmSync, writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withWorkspace } from './codex-process.mjs';
import { withCodexAppServer } from './codex-provider.mjs';
import { withLock } from './directory-lock.mjs';

const MODES = ['normal', 'turbo', 'manual', 'off'];
const DEFAULTS = { mode: 'normal', model: null, effort: null };
const own = Object.hasOwn;

function settingsPath() {
  const directory = process.env.CODEX_POLISH_AGY_SETTINGS_DIR || join('.gemini', 'config', 'agy-polish');
  return resolve(homedir(), directory, 'settings.json');
}

function readDocument(file) {
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid polishing settings');
  }
  return value;
}

function validate(key, value) {
  if (key === 'mode' && MODES.includes(value)) return;
  if (key !== 'mode' && (value === null ||
      (typeof value === 'string' && value.trim() === value && value && !/[\x00-\x1f\x7f]/.test(value)))) return;
  throw new Error(`Invalid polishing ${key}`);
}

function preferences(document) {
  const values = { ...DEFAULTS };
  for (const key of Object.keys(values)) {
    if (!own(document, key)) continue;
    validate(key, document[key]);
    values[key] = document[key];
  }
  return values;
}

export function readSettings() {
  return preferences(readDocument(settingsPath()));
}

const lockWait = new Int32Array(new SharedArrayBuffer(4));

function replaceSettings(source, destination) {
  for (let attempts = 0; ; attempts++) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempts === 10) throw error;
      Atomics.wait(lockWait, 0, 0, 20);
    }
  }
}

export async function writeSettings(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Invalid polishing settings patch');
  }
  const keys = Object.keys(patch);
  for (const key of keys) {
    if (!own(DEFAULTS, key)) throw new Error('Unknown polishing setting');
    validate(key, patch[key]);
  }
  if (!keys.length) return readSettings();

  const file = settingsPath();
  // A separate directory also works when the installer already holds the host profile lock.
  const writer = join(dirname(file), '.settings-writer');
  mkdirSync(writer, { recursive: true, mode: 0o700 });
  return withLock(writer, () => {
    const document = { ...readDocument(file), ...patch };
    const settings = preferences(document);
    const stage = join(writer, randomUUID() + '.tmp');
    try {
      writeFileSync(stage, JSON.stringify({ ...document, ...settings }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      replaceSettings(stage, file);
      return settings;
    } finally {
      rmSync(stage, { force: true });
    }
  });
}

export async function listModels({ signal, timeout = 20_000 } = {}) {
  return withWorkspace(({ cwd }) => withCodexAppServer(cwd, { signal, timeout }, async (request) => {
    const { config } = await request('config/read', { includeLayers: false, cwd });
    const providerId = config.model_provider;
    const provider = config.model_providers?.[providerId];
    const hasNativeCatalog = ['openai', 'gcp', 'amazon-bedrock', 'amazon-bedrock-runtime'].includes(providerId);
    const configured = config.model ? {
      id: config.model, name: config.model, efforts: [], defaultEffort: null, isDefault: true
    } : null;
    // Without a catalog a custom Responses endpoint gets Codex's bundled OpenAI picker.
    // The configured model is the only model we can attribute to that endpoint.
    if (provider && !hasNativeCatalog && !provider.model_catalog_url && !config.model_catalog_json) {
      return configured ? [configured] : [];
    }
    const models = new Map();
    const cursors = new Set();
    let cursor;
    do {
      const page = await request('model/list', {
        limit: 100, includeHidden: false, ...(providerId && { modelProvider: providerId }), ...(cursor && { cursor })
      });
      if (!Array.isArray(page.data)) throw new Error('Invalid Codex model catalog');
      for (const model of page.data) {
        if (model?.hidden || typeof model?.id !== 'string' || !model.id) continue;
        models.set(model.id, {
          id: model.id,
          name: model.displayName || model.id,
          efforts: (model.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort),
          defaultEffort: model.defaultReasoningEffort ?? null,
          isDefault: configured ? model.id === configured.id : model.isDefault === true
        });
      }
      cursor = page.nextCursor;
      if (cursor != null) {
        if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('Invalid Codex model cursor');
        cursors.add(cursor);
      }
    } while (cursor != null);
    if (configured && !models.has(configured.id)) models.set(configured.id, configured);
    return [...models.values()];
  }));
}

export async function runSettingsCommand([command, ...args]) {
  try {
    let result;
    if (command === 'show' && !args.length) result = readSettings();
    else if (command === 'list-models' && !args.length) result = await listModels();
    else if (command === 'set' && args.length && args.length % 2 === 0) {
      const patch = {};
      for (let i = 0; i < args.length; i += 2) {
        const flag = args[i];
        const value = args[i + 1];
        if (!['--mode', '--model', '--effort'].includes(flag) || value.startsWith('--')) throw new Error('Invalid flag');
        const key = flag.slice(2);
        if (own(patch, key)) throw new Error('Duplicate flag');
        patch[key] = key !== 'mode' && value === 'default' ? null : value;
      }
      result = await writeSettings(patch);
    } else {
      throw new Error('Invalid command');
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch {
    const message = command === 'list-models'
      ? 'Could not list Codex models. Check the local Codex CLI and its sign-in.'
      : 'Could not access reply polishing settings. Use show, list-models, or set with --mode, --model, or --effort.';
    process.stderr.write(message + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runSettingsCommand(process.argv.slice(2));
}
