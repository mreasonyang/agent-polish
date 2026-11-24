import { on } from 'node:events';
import { clearLine, cursorTo, emitKeypressEvents, moveCursor } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { tr } from './installer_locale.mjs';

export async function ask(prompt) {
  const io = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  io.once('SIGINT', cancel);
  io.once('close', cancel);
  try {
    return (await io.question(prompt, { signal: controller.signal })).trim();
  } catch {
    console.log();
    return null;
  } finally {
    io.close();
  }
}
export async function* terminalKeys(input, output, show, signal) {
  if (input.destroyed || input.readableEnded || signal?.aborted) return;
  const wasRaw = !!input.isRaw;
  const wasFlowing = input.readableFlowing;
  function restoreInput() {
    if (!wasRaw && input.isRaw && !input.destroyed) input.setRawMode(false);
  }
  emitKeypressEvents(input);
  const keys = on(input, 'keypress', { close: ['end', 'close'], signal });
  // A stream may destroy its terminal handle immediately after emitting end.
  input.once('end', restoreInput);
  try {
    if (!wasRaw) input.setRawMode(true);
    input.resume();
    show();
    yield* keys;
  } catch (error) {
    if (!signal?.aborted || error.name !== 'AbortError') throw error;
  } finally {
    await keys.return();
    input.off('end', restoreInput);
    restoreInput();
    if (!wasFlowing) input.pause();
    output.write('\n');
  }
}
export async function chooseOption(title, options, lang, input = process.stdin, output = process.stdout, initialChoice, signal) {
  let selected = Math.max(0, options.findIndex(option => option.id === initialChoice));
  function draw() {
    for (const [index, option] of options.entries()) {
      clearLine(output, 0);
      // A provider label is display text, including any literal terminal controls.
      const label = option.name.replace(/\p{Cc}/gu, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
      output.write((selected === index ? '❯ ● ' : '  ○ ') + label);
      if (index < options.length - 1) output.write('\r\n');
    }
  }
  const show = () => {
    output.write(title + '\n' + tr('用 ↑ ↓ 移动，按回车确认，按 Esc 取消。\n', 'Use ↑ ↓ to move, Enter to confirm, or Esc to cancel.\n', lang));
    draw();
  };
  for await (const [, key] of terminalKeys(input, output, show, signal)) {
    if (key.name === 'return' || key.name === 'enter') return options[selected].id;
    if (key.name === 'escape' || (key.ctrl && ['c', 'd'].includes(key.name))) return null;
    if (key.name !== 'up' && key.name !== 'down') continue;
    const next = Math.max(0, Math.min(options.length - 1, selected + (key.name === 'up' ? -1 : 1)));
    if (next === selected) continue;
    selected = next;
    moveCursor(output, 0, 1 - options.length);
    cursorTo(output, 0);
    draw();
  }
  return null;
}

export function chooseOnboardingMode(title, current, lang, input, output) {
  const label = (zh, en) => tr(zh, en, lang);
  const choices = [
    { id: 'normal', name: label('自动润色（Normal）', 'Automatic polishing (Normal)') },
    { id: 'manual', name: label('仅在点名时润色', 'Polish only when asked') }
  ];
  const retained = {
    turbo: label('保留当前设置（Turbo）', 'Keep current setting (Turbo)'),
    off: label('保留当前设置（已关闭）', 'Keep current setting (Off)'),
    invalid: label('保留当前设置', 'Keep current setting')
  };
  if (Object.hasOwn(retained, current)) choices.unshift({ id: current, name: retained[current] });
  return chooseOption(title, choices, lang, input, output, current);
}

// Keep Esc, Ctrl-C and EOF responsive while the Codex agent reads account metadata.
export async function waitForCatalog(operation, message, input, output, signal) {
  const controller = new AbortController();
  const cancelled = (async () => {
    const show = () => output.write(message);
    for await (const [, key] of terminalKeys(input, output, show, AbortSignal.any([signal, controller.signal]))) {
      if (key.name === 'escape' || (key.ctrl && ['c', 'd'].includes(key.name))) break;
    }
    return null;
  })();
  try {
    return await Promise.race([cancelled, operation()]);
  } finally {
    controller.abort();
    await cancelled;
  }
}

export const thinkingLabels = {
  low: ['低', 'Low'], medium: ['中', 'Medium'], high: ['高', 'High'], xhigh: ['极高', 'Extra High'],
  fixed: ['由模型固定', 'Fixed by the model']
};
