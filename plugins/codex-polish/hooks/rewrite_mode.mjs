import { readProjectSetting } from './project_setting.mjs';

export const REWRITE_MODE_FILE = 'codex-polish.rewrite-mode';
export const REWRITE_MODES = ['normal', 'turbo'];

export function rewriteModeSettings(cwd) {
  const [value] = readProjectSetting(cwd, REWRITE_MODE_FILE, 16, { allowMissingLink: true });
  if (value === null) return { rewrite_mode: 'normal', rewrite_mode_configured: false };
  const valid = REWRITE_MODES.includes(value);
  return { rewrite_mode: valid ? value : null, rewrite_mode_configured: valid };
}

export function projectRewriteMode(cwd) {
  return rewriteModeSettings(cwd).rewrite_mode;
}
