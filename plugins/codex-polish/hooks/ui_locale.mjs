import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readProjectSetting } from './project_setting.mjs';

export const LANGUAGE_FILE = 'codex-polish.language';
export const LANGUAGES = ['auto', 'zh', 'en'];

function languageTag(value) {
  const tag = value.trim().toLowerCase().split(/[-_.@]/, 1)[0];
  return tag === 'zh' || tag === 'en' ? tag : null;
}

export function appleLanguage(output) {
  for (const item of output.trim().replace(/^\(|\)$/g, '').split(',')) {
    const tag = languageTag(item.trim().replace(/^"|"$/g, ''));
    if (tag) return tag;
  }
  return 'en';
}

let desktopLanguage;
function macLanguage() {
  if (desktopLanguage === undefined) {
    try {
      desktopLanguage = appleLanguage(execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], {
        encoding: 'utf8', timeout: 400, stdio: ['ignore', 'pipe', 'ignore'],
      }));
    } catch {
      desktopLanguage = 'en';
    }
  }
  return desktopLanguage;
}

export function systemLanguage(env = process.env) {
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = env[name]?.trim();
    if (value) return languageTag(value) || 'en';
  }
  return process.platform === 'darwin' ? macLanguage() : 'en';
}

export function languageSettings(cwd, env = process.env) {
  let directory;
  try {
    directory = path.resolve(cwd ?? '.');
  } catch {
    directory = '';
  }
  const [saved] = readProjectSetting(directory, LANGUAGE_FILE, 16, { allowMissingLink: true });
  const mode = saved === 'en' || saved === 'zh' ? saved : 'auto';
  return { language_mode: mode, ui_language: mode === 'auto' ? systemLanguage(env) : mode };
}

export function language(cwd, env) {
  return languageSettings(cwd, env).ui_language;
}

export function tr(zh, en, lang) {
  return (lang ?? language()) === 'zh' ? zh : en;
}
