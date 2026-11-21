import { readProfileSetting } from './profile_setting.mjs';

export const REWRITE_MODE_FILE = 'codex-polish.rewrite-mode';
export const REWRITE_MODES = ['normal', 'turbo'];
export const REWRITE_TRIGGERS = ['auto', 'explicit'];

export function rewriteModeSettings(trigger) {
  const value = readProfileSetting(REWRITE_MODE_FILE, 16);
  const normalized = value?.toLowerCase();
  const configuredMode = REWRITE_MODES.includes(normalized) ? normalized : null;
  const automaticMode = value === null ? 'normal' : configuredMode;
  return { rewrite_mode: trigger === 'explicit' ? 'turbo' : automaticMode, rewrite_mode_configured: configuredMode !== null };
}

export function effectiveRewriteMode(trigger) {
  return rewriteModeSettings(trigger).rewrite_mode;
}
