import { readProjectSetting } from './project_setting.mjs';

export const REWRITE_MODE_FILE = 'codex-polish.rewrite-mode';
export const REWRITE_MODES = ['normal', 'turbo'];
export const REWRITE_TRIGGERS = ['auto', 'explicit', 'turbo'];

export function rewriteModeSettings(cwd, trigger) {
  const [value] = readProjectSetting(cwd, REWRITE_MODE_FILE, 16, { allowMissingLink: true });
  if (value !== null && !REWRITE_MODES.includes(value)) return { rewrite_mode: null, rewrite_mode_configured: false };
  return { rewrite_mode: trigger === 'turbo' ? 'turbo' : (value ?? 'normal'), rewrite_mode_configured: value !== null };
}

export function projectRewriteMode(cwd) {
  return rewriteModeSettings(cwd).rewrite_mode;
}

export function effectiveRewriteMode(cwd, trigger) {
  return rewriteModeSettings(cwd, trigger).rewrite_mode;
}
