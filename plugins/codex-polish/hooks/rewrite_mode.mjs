import { readSettingWithDefault } from './project_setting.mjs';

export const REWRITE_MODE_FILE = 'codex-polish.rewrite-mode';
export const REWRITE_MODES = ['normal', 'turbo'];
export const REWRITE_TRIGGERS = ['auto', 'explicit'];

export function rewriteModeSettings(cwd, trigger) {
  const value = readSettingWithDefault(cwd, REWRITE_MODE_FILE, 16);
  const normalized = value?.toLowerCase();
  const configuredMode = REWRITE_MODES.includes(normalized) ? normalized : null;
  const automaticMode = value === null ? 'normal' : configuredMode;
  return { rewrite_mode: trigger === 'explicit' ? 'turbo' : automaticMode, rewrite_mode_configured: configuredMode !== null };
}

export function projectRewriteMode(cwd) {
  return rewriteModeSettings(cwd).rewrite_mode;
}

export function effectiveRewriteMode(cwd, trigger) {
  return rewriteModeSettings(cwd, trigger).rewrite_mode;
}
