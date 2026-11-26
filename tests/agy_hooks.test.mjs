import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { windows } from './hook_fixture.mjs';
import { isolatedHosts, reversePlugin, withSettings } from './host_fixture.mjs';

test('native Antigravity hooks tell the model to answer ordinary questions directly in manual and off', {
  skip: windows && 'requires the shell used by the native plugin commands'
}, t => {
  const fixture = isolatedHosts(t);
  const plugin = join(fixture.base, '已安装 plugin');
  fs.cpSync(reversePlugin, plugin, { recursive: true });
  const config = JSON.parse(fs.readFileSync(join(plugin, 'hooks.json'), 'utf8'));
  const groups = Object.values(config).filter(group => group.enabled !== false);
  const handlers = groups.flatMap(group => group.PreInvocation ?? []);
  assert.ok(handlers.length, 'mode changes must reach the model before its next invocation');
  const currentTurn = {
    conversationId: 'ec33ebf9-0cba-4100-8142-c61503f6c587',
    invocationNum: 0,
    initialNumSteps: 2,
    workspacePaths: [fixture.workspace],
    transcriptPath: join(fixture.base, 'nonexistent-fixture-transcript.jsonl'),
    artifactDirectoryPath: join(fixture.base, 'artifacts'),
    modelName: 'gemini-fixture',
    lastUserInput: '请用一句话解释 DNS。'
  };
  for (const mode of ['manual', 'off']) {
    if (mode === 'off') withSettings(fixture, 'await settings.writeSettings({ mode: "off" });');
    const messages = handlers.flatMap(handler => {
      assert.equal(handler.type, 'command');
      assert.equal(typeof handler.command, 'string');
      const result = fixture.run('/bin/sh', ['-c', handler.command], {
        cwd: plugin, input: JSON.stringify(currentTurn), stdio: ['pipe', 'pipe', 'pipe']
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const response = JSON.parse(result.stdout);
      assert.ok(!response.terminationBehavior, 'ordinary questions must still reach the model');
      assert.ok(Array.isArray(response.injectSteps), result.stdout);
      return response.injectSteps.map(step => step.systemMessage?.systemMessage ?? step.ephemeralMessage);
    }).join('\n');
    assert.match(messages, new RegExp(`\\b${mode}\\b`, 'i'));
    assert.match(messages, /\b(?:deliver|publish|send|answer|respond)\b/i);
    assert.match(messages, /\b(?:do not|don't|never|skip|without|must not)\b[^.\n]*\bpolish_reply\b|\bpolish_reply\b[^.\n]*\b(?:must not|should not)\b/i);
    if (mode === 'off') {
      assert.match(messages, /do not call polish_reply or invoke Codex/i);
      assert.match(messages, /supplied text or a previous reply[^.]*verbatim/i);
      assert.match(messages, /leading and trailing whitespace, line breaks, Markdown, and code/i);
      assert.match(messages, /do not rewrite it yourself/i);
      assert.match(messages, /\/polish[^.]*new question or task[^.]*answer it normally/i);
    }
    currentTurn.initialNumSteps += 4;
  }
  assert.deepEqual(fixture.records(), [], 'the hook communicates mode without invoking either CLI');
});

test('a standalone 说人话 edits the previous reply explicitly and respects Off', t => {
  const fixture = isolatedHosts(t);
  function hook(lastUserInput, invocationNum) {
    const result = fixture.run(process.execPath, [join(reversePlugin, 'scripts', 'mode-hook.mjs')], {
      input: JSON.stringify({ lastUserInput, invocationNum }), stdio: ['pipe', 'pipe', 'pipe']
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).injectSteps?.[0].systemMessage.systemMessage;
  }

  for (const mode of ['normal', 'turbo', 'manual']) {
    withSettings(fixture, 'await settings.writeSettings({ mode: process.argv[1] });', [mode]);
    const message = hook('说人话');
    assert.match(message, /trigger "explicit"/);
    assert.match(message, /previous assistant reply verbatim as draft/);
    assert.match(message, /exact user request as rewrite_request/);
    assert.doesNotMatch(message, /trigger auto/);
  }
  assert.equal(hook(' 说人话！ '), hook('说人话'));
  assert.equal(hook('说人话', 1), undefined);
  const ordinary = hook('请解释 DNS。');
  for (const prompt of ['“说人话”是什么意思？', '别说人话', '说人话？', '什么是 DNS？请说人话。']) {
    assert.equal(hook(prompt), ordinary);
  }

  withSettings(fixture, 'await settings.writeSettings({ mode: "off" });');
  const off = hook('说人话');
  assert.match(off, /previous assistant reply verbatim/i);
  assert.match(off, /do not call polish_reply or invoke Codex/i);
  assert.doesNotMatch(off, /trigger "explicit"/);
  assert.deepEqual(fixture.records(), []);
});
