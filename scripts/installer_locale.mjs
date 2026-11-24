import { execFileSync } from 'node:child_process';
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
  if (process.platform === 'win32') return languageTag(Intl.DateTimeFormat().resolvedOptions().locale) || 'en';
  return process.platform === 'darwin' ? macLanguage() : 'en';
}

export function tr(zh, en, lang = systemLanguage()) {
  return lang === 'zh' ? zh : en;
}
