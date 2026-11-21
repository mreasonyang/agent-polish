// The native host cross-connects stdout/stdin to the official process. The relay
// writes a record only while handling a separate command executed by the agent.
import { setTimeout as delay } from 'node:timers/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimWindowsWorkspace, dispose } from './acp_workspace.mjs';
import { observe } from './acp_observe.mjs';
import { decode, encode, exchange, listenPrivate, windowsCommand } from './acp_windows_io.mjs';
import { isMain } from './cli_io.mjs';

const self = fileURLToPath(import.meta.url);
const payload = fileURLToPath(new URL('acp_payload.mjs', import.meta.url));

async function relay(settings, parent) {
  const { directory, owners } = settings;
  claimWindowsWorkspace(directory, owners);
  let submitted;
  let resolveMaterial;
  const material = new Promise(resolve => { resolveMaterial = resolve; });
  let shuttingDown = false;
  let shutdownTimer;
  let active = 0;
  async function forward({ operation, frame, original }, afterFlush) {
    if (operation === 'stop') { afterFlush(() => stop()); return true; }
    if (shuttingDown || !frame || frame.jsonrpc !== '2.0') throw Error('invalid_frame');
    if (frame.method === 'session/prompt') {
      if (submitted !== undefined || frame.id !== 6 || !original || typeof original.draft !== 'string' ||
          typeof frame.params?.sessionId !== 'string') throw Error('invalid_submission');
      submitted = frame.params.sessionId;
      resolveMaterial(original);
    } else if (original !== undefined) throw Error('invalid_frame');
    active++;
    let counted = true;
    const release = () => {
      if (!counted) return;
      counted = false;
      active--;
      if (shuttingDown && !active) process.exit(0);
    };
    try {
      await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(frame) + '\n', e => e ? reject(e) : resolve()));
      afterFlush(release);
      return true;
    } catch (e) { release(); throw e; }
  }
  const channel = await listenPrivate(forward).catch(error => {
    dispose(directory, owners);
    throw error;
  });

  function stop(grace = 0) {
    clearTimeout(shutdownTimer);
    shutdownTimer = setTimeout(() => {
      shuttingDown = true;
      channel.server.close();
      if (!active) process.exit(0);
      setTimeout(() => process.exit(1), 3000).unref();
    }, grace);
  }
  let lost = false;
  async function parentLost() {
    if (lost) return;
    lost = true;
    channel.close();
    // Kernel job teardown can still be releasing the provider's cwd handle.
    for (let attempt = 0; attempt < 30; attempt++) {
      try { dispose(directory, owners); break; } catch { await delay(100); }
    }
    process.exit(1);
  }
  function hostAlive() {
    try { process.kill(parent, 0); return true; } catch { return false; }
  }
  setInterval(() => { if (!hostAlive()) void parentLost(); }, 250).unref();
  process.stderr.on('error', () => void parentLost());
  process.stdout.on('error', () => { if (!hostAlive()) void parentLost(); else stop(); });
  const command = args => windowsCommand([process.execPath, ...args], dirname(directory));
  const transport = { material, submitted: () => submitted,
    write: frame => command([self, '--frame', channel.endpoint, encode(frame)]),
    submit: args => ({ ...command([payload, '--windows-submit', channel.endpoint, encode(args)]), tty: true, yield_time_ms: 250 }),
  };
  const emit = event => {
    if (event.event === 'send' || event.event === 'submit') event.stop = command([self, '--stop', channel.endpoint]);
    process.stderr.write(JSON.stringify(event) + '\n', () => {
      if (!hostAlive()) { void parentLost(); return; }
      if (['delivery', 'catalog', 'error', 'closed'].includes(event.event)) stop(event.finish ? 3000 : 0);
    });
  };
  process.stdout.write('R'); // The host starts agy only after the exclusive workspace claim.
  await observe(process.stdin, { ...settings, transport, onDrained: () => stop() }, emit);
  if (!hostAlive()) await parentLost();
}

if (isMain(import.meta.url)) {
  try {
    const [operation, first, second] = process.argv.slice(2);
    if (operation === '--observe') {
      const parent = Number(second);
      if (!Number.isSafeInteger(parent) || parent <= 0 || parent !== process.ppid) throw Error('invalid_parent');
      await relay(decode(first), parent);
    } else if (operation === '--frame') {
      if (await exchange(first, { frame: decode(second) }, 32) !== true) throw Error('acp_write_failed');
    } else if (operation === '--stop') {
      if (await exchange(first, { operation: 'stop' }, 32) !== true) throw Error('acp_stop_failed');
    } else if (operation === '--dispose' || operation === '--dispose-unclaimed') {
      const { directory, owners } = decode(first);
      if (operation === '--dispose-unclaimed') claimWindowsWorkspace(directory, owners);
      dispose(directory, owners);
    } else throw Error('invalid_operation');
  } catch { process.exitCode = 1; }
}
