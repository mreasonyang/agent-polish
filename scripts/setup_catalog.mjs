// The installer observes completed metadata on disk. Only Codex holds the agy terminal.
import fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { executable, sameEntry, windows, windowsSystemTool } from '../plugins/codex-polish/hooks/platform.mjs';
import { parseAcpFrame } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_reader.mjs';
import { catalog, MAX_CONFIG_FRAME_BYTES } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_models.mjs';
import { dispose, prepareWorkspace, readOutput } from '../plugins/codex-polish/skills/codex-polish/scripts/acp_workspace.mjs';
import { record } from '../plugins/codex-polish/skills/codex-polish/scripts/cli_io.mjs';
import { createCatalogTask } from './setup_catalog_task.mjs';

// Command-list notifications can be much larger than either menu's metadata.
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

function protocolError() { return Error('invalid_catalog_response'); }

function waitForExit(exited, ms) {
  let timer;
  const elapsed = new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); });
  return Promise.race([exited, elapsed]).finally(() => clearTimeout(timer));
}

function stopTree(child, force) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (windows) {
    spawnSync(windowsSystemTool('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    child.kill('SIGKILL');
  } else {
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGINT'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export function openSetupCatalog(checks, { cli = executable('codex'), timeoutMs = 120_000, closeGraceMs = 4_000 } = {}) {
  let workspace, workspaceStat, choiceFile, choiceStat, childTemp, childTempStat, child, exited, ended = false;
  let closing, closed = false, first, target, selection, initial, selected, sessionId;
  let offset = 0, fragments = [], recordBytes = 0, expected = 1n;

  function accept(line) {
    const frame = parseAcpFrame(line, { bigintIds: true });
    if (!record(frame) || frame.jsonrpc !== '2.0') throw protocolError();
    // Codex handles provider requests. Command updates and other notifications do not populate a menu.
    if (typeof frame.method === 'string' && !('result' in frame) && !('error' in frame)) return;
    if (recordBytes > MAX_CONFIG_FRAME_BYTES) throw protocolError();
    if (frame.id !== expected || !record(frame.result) || 'method' in frame || 'error' in frame) throw protocolError();
    if (expected === 1n) {
      if (frame.result.protocolVersion !== 1) throw protocolError();
      expected = checks.google_auth_method === 'existing-session' ? 3n : 2n;
    } else if (expected === 2n) {
      expected = 3n;
    } else if (expected === 3n) {
      sessionId = frame.result.sessionId;
      if (typeof sessionId !== 'string' || !sessionId.trim()) throw protocolError();
      initial = catalog(frame.result.configOptions);
      if (!initial.models.length) throw protocolError();
      expected = null;
    } else if (expected === 4n) {
      if (frame.result.sessionId !== undefined && frame.result.sessionId !== sessionId) throw protocolError();
      selected = catalog(frame.result.configOptions);
      if (selected.current_model !== target) throw protocolError();
      expected = 7n;
    } else if (expected === 7n) {
      expected = null;
    } else throw protocolError();
  }

  // readOutput pins the original regular file and preserves UTF-8 across page boundaries.
  function drain() {
    for (;;) {
      const page = readOutput(workspace.workspace, workspace.cleanup_token, offset);
      if (!page.text) return;
      offset = page.next_offset;
      const parts = page.text.split('\n');
      for (const [i, part] of parts.entries()) {
        recordBytes += Buffer.byteLength(part);
        if (recordBytes > MAX_RECORD_BYTES) throw protocolError();
        fragments.push(part);
        if (i < parts.length - 1) {
          accept(fragments.join(''));
          fragments = [];
          recordBytes = 0;
        }
      }
    }
  }

  async function waitFor(getResult) {
    const deadline = performance.now() + timeoutMs;
    while (!closed) {
      drain();
      const result = getResult();
      if (result) return result;
      if (ended) throw Error('catalog_process_ended');
      if (performance.now() >= deadline) throw Error('catalog_timeout');
      await sleep(60);
    }
    throw Error('catalog_closed');
  }

  function ownsWorkspace() {
    const current = fs.lstatSync(workspace.workspace, { bigint: true, throwIfNoEntry: false });
    return current?.isDirectory() && sameEntry(current, workspaceStat);
  }

  function publish(value) {
    if (choiceStat) return;
    if (!ownsWorkspace()) throw Error('workspace_changed');
    const staged = choiceFile + '.tmp';
    fs.writeFileSync(staged, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    try {
      fs.renameSync(staged, choiceFile);
      choiceStat = fs.lstatSync(choiceFile, { bigint: true });
    } finally {
      fs.rmSync(staged, { force: true });
    }
  }

  async function start() {
    if (closed) throw Error('catalog_closed');
    if (!cli) throw Error('codex_missing');
    workspace = prepareWorkspace({ catalog: true });
    workspaceStat = fs.lstatSync(workspace.workspace, { bigint: true });
    childTemp = join(workspace.workspace, 'tmp');
    fs.mkdirSync(childTemp, { mode: 0o700 });
    childTempStat = fs.lstatSync(childTemp, { bigint: true });
    choiceFile = join(workspace.workspace, 'selection-' + randomUUID() + '.json');
    const task = createCatalogTask({
      agyPath: checks.agy_path, authMethod: checks.google_auth_method, workspace, choiceFile
    });
    child = spawn(cli.command, [...cli.args, 'exec', '--ephemeral', '--skip-git-repo-check', '-C', workspace.workspace,
      '-c', 'plugins."codex-polish@codex-polish-local".enabled=false', task],
    { cwd: workspace.workspace, stdio: 'ignore', detached: !windows, windowsHide: true,
      env: { ...process.env, TMPDIR: childTemp, TMP: childTemp, TEMP: childTemp } });
    exited = new Promise(resolve => {
      const onEnd = () => { ended = true; resolve(true); };
      child.once('error', onEnd);
      child.once('close', onEnd);
    });
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    return waitFor(() => initial);
  }

  function list() {
    if (closed) return Promise.reject(Error('catalog_closed'));
    return first ??= start();
  }

  async function select(model) {
    const account = await list();
    if (closed) throw Error('catalog_closed');
    if (!account.models.some(item => item.id === model)) throw Error('catalog_model_unavailable');
    if (target !== undefined && target !== model) throw Error('catalog_selection_already_made');
    if (selection) return selection;
    // Drain before publishing so an unsolicited earlier id=4 cannot satisfy this selection.
    drain();
    target = model;
    if (model === account.current_model) {
      expected = 7n;
      publish({ close: true });
      selection = Promise.resolve(account);
    } else {
      if (ended) throw Error('catalog_process_ended');
      publish({ model });
      expected = 4n;
      selection = waitFor(() => selected);
    }
    return selection;
  }

  function cleanup() {
    if (!workspace) return;
    try {
      if (!ownsWorkspace()) return;
      const current = choiceStat && fs.lstatSync(choiceFile, { bigint: true, throwIfNoEntry: false });
      if (current && sameEntry(current, choiceStat)) fs.unlinkSync(choiceFile);
      // Codex may leave ephemeral files when interrupted. Only its private scratch tree belongs to us.
      const temp = childTempStat && fs.lstatSync(childTemp, { bigint: true, throwIfNoEntry: false });
      if (temp?.isDirectory() && sameEntry(temp, childTempStat))
        fs.rmSync(childTemp, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    } finally { dispose(workspace.workspace, workspace.cleanup_token); }
  }

  async function stop() {
    try {
      if (!child || ended) return;
      try {
        if (!choiceStat) publish({ close: true });
        // Give the agent time to close its own provider session and terminal.
        if (await waitForExit(exited, closeGraceMs)) return;
      } finally {
        if (!ended) {
          stopTree(child, false);
          if (!windows && !(await waitForExit(exited, 1_000))) stopTree(child, true);
          if (!(await waitForExit(exited, 3_000))) throw Error('catalog_process_did_not_stop');
        }
      }
    } finally {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onInterrupt);
      if (!child || ended) cleanup();
      else exited.then(cleanup).catch(() => {});
    }
  }

  function onInterrupt() { close().catch(() => {}); }
  function close() {
    closed = true;
    return closing ??= stop();
  }

  return { list, select, close };
}
