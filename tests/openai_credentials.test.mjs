import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { clearOpenAIKey, readOpenAIKey, saveOpenAIKey } from '../plugins/codex-polish/hooks/openai_credentials.mjs';
import { windowsSystemTool } from '../plugins/codex-polish/hooks/platform.mjs';
import { temporary, useTestProfile, supportsFileSymlink, windows } from './hook_fixture.mjs';

function fixture(t) {
  const profile = useTestProfile(t);
  const directory = path.join(profile, 'codex-polish', 'credentials');
  return { profile, directory, file: path.join(directory, 'openai.key') };
}

test('key saves are private, replaceable and scoped to the active profile', t => {
  const { profile, directory, file } = fixture(t);
  assert.equal(readOpenAIKey(), null);
  clearOpenAIKey();
  assert.equal(fs.existsSync(profile), false);
  saveOpenAIKey('first-fixture-key');
  assert.equal(readOpenAIKey(), 'first-fixture-key');
  if (!windows) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  for (const key of ['', ' ', 'trailing-space ', 'embedded\nnewline', '含中文', 'x'.repeat(4097)]) {
    assert.throws(() => saveOpenAIKey(key), { name: 'RangeError', message: 'Invalid OpenAI API key' });
  }
  assert.equal(readOpenAIKey(), 'first-fixture-key');
  saveOpenAIKey('second-fixture-key');
  assert.deepEqual(fs.readdirSync(directory), ['openai.key']);
  process.env.CODEX_HOME = temporary(t);
  assert.equal(readOpenAIKey(), null);
  clearOpenAIKey();
  process.env.CODEX_HOME = profile;
  assert.equal(readOpenAIKey(), 'second-fixture-key');
  const extra = path.join(directory, 'another-file');
  fs.writeFileSync(extra, 'keep');
  clearOpenAIKey();
  assert.equal(readOpenAIKey(), null);
  assert.equal(fs.readFileSync(extra, 'utf8'), 'keep');
  fs.unlinkSync(extra);
  clearOpenAIKey();
  assert.equal(fs.existsSync(directory), false);
});

test('the credential reader rejects hard links, broad permissions, and oversized or corrupt bytes', t => {
  const { file } = fixture(t);
  saveOpenAIKey('fixture-key');
  const extra = path.join(temporary(t), 'another-name');
  fs.linkSync(file, extra);
  assert.equal(readOpenAIKey(), '');
  fs.unlinkSync(extra);
  if (windows) execFileSync(windowsSystemTool('icacls.exe'), [file, '/grant', '*S-1-1-0:(R)']);
  else fs.chmodSync(file, 0o644);
  assert.equal(readOpenAIKey(), '');
  saveOpenAIKey('replacement-key');
  assert.equal(readOpenAIKey(), 'replacement-key');
  for (const bytes of [Buffer.from([0xff]), Buffer.alloc(4097, 0x61), Buffer.from('key\n'), Buffer.alloc(0)]) {
    fs.writeFileSync(file, bytes);
    assert.equal(readOpenAIKey(), '');
  }
  clearOpenAIKey();
  assert.equal(readOpenAIKey(), null);
});

test('the credential store refuses linked directories and files without changing their targets', t => {
  const { file, directory } = fixture(t);
  saveOpenAIKey('fixture-key');
  fs.unlinkSync(file);
  const outside = temporary(t);
  const target = path.join(outside, 'openai.key');
  fs.writeFileSync(target, 'outside-key', { mode: 0o600 });
  if (supportsFileSymlink()) {
    fs.symlinkSync(target, file);
    assert.equal(readOpenAIKey(), '');
    assert.throws(() => saveOpenAIKey('next-key'));
    assert.throws(() => clearOpenAIKey());
    fs.unlinkSync(file);
  }
  fs.rmdirSync(directory);
  fs.symlinkSync(outside, directory, 'junction');
  assert.equal(readOpenAIKey(), '');
  assert.throws(() => saveOpenAIKey('next-key'));
  assert.throws(() => clearOpenAIKey());
  assert.equal(fs.readFileSync(target, 'utf8'), 'outside-key');
});
