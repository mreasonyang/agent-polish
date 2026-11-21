import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRegular, sameEntry, windows } from './platform.mjs';
import { withSettingsDirectory } from './profile_setting.mjs';
import { createPrivateDirectory, privateFile } from './recovery.mjs';
import { checkPrivatePaths } from '../skills/codex-polish/scripts/acp_windows_io.mjs';

const FILE = 'openai.key';
const MAX_LENGTH = 4096;

function validKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_LENGTH && !/[^!-~]/.test(key);
}

function withCredentialParent(create, use) {
  const root = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'codex-polish');
  if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return withSettingsDirectory(root, () => {
    const parent = fs.statSync('.');
    if (!windows && (parent.uid !== process.getuid() || (parent.mode & 0o022)))
      throw new Error('Invalid credential parent directory permissions');
    return use();
  });
}

function checkPrivate(file, fd) {
  const directory = fs.statSync('.');
  if (!windows && (directory.uid !== process.getuid() || (directory.mode & 0o077)))
    throw new Error('Invalid credential directory permissions');
  if (!privateFile(file, fs.fstatSync(fd), false)) throw new Error('Invalid credential file');
  if (windows) checkPrivatePaths([
    { path: process.cwd(), directory: true }, { path: path.resolve(file), directory: false },
  ]);
}

export function readOpenAIKey() {
  try {
    return withCredentialParent(false, () => withSettingsDirectory('credentials', () => {
      const fd = openRegular(FILE);
      try {
        checkPrivate(FILE, fd);
        const bytes = Buffer.alloc(MAX_LENGTH + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
          if (!count) break;
          length += count;
        }
        const key = bytes.toString('latin1', 0, length);
        return validKey(key) ? key : '';
      } finally { fs.closeSync(fd); }
    }));
  } catch (error) { return error.code === 'ENOENT' ? null : ''; }
}

export function openAIKeyStatus(key = readOpenAIKey()) {
  return { openai_key_configured: Boolean(key), openai_key_malformed: key === '' };
}

export function saveOpenAIKey(key) {
  if (!validKey(key)) throw new RangeError('Invalid OpenAI API key');
  withCredentialParent(true, () => {
    for (let attempt = 0; ; attempt++) {
      try {
        createPrivateDirectory('credentials');
        withSettingsDirectory('credentials', access => access('write', FILE, Buffer.from(key, 'ascii'), checkPrivate));
        return;
      } catch (error) {
        // A concurrent clear can remove the empty directory before the new file is staged.
        if (error.code !== 'ENOENT' || attempt >= 2) throw error;
      }
    }
  });
}

export function clearOpenAIKey() {
  try {
    withCredentialParent(false, () => {
      const original = withSettingsDirectory('credentials', access => {
        access('remove', FILE);
        return fs.statSync('.', { bigint: true });
      });
      const current = fs.lstatSync('credentials', { bigint: true, throwIfNoEntry: false });
      if (current?.isDirectory() && sameEntry(original, current)) fs.rmdirSync('credentials');
    });
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}
