// Prepare the host command. Only the agent's execution tool launches Antigravity.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validModelId } from '../../../hooks/preferences.mjs';
import { isMain } from './cli_io.mjs';
import { editorRole } from './editor_role.mjs';

const self = fileURLToPath(import.meta.url);
const terminal = fileURLToPath(new URL('acp_terminal.sh', import.meta.url));
const observer = fileURLToPath(new URL('acp_observe.mjs', import.meta.url));
const stockRole = new URL('../references/codex-polish-editor.md', import.meta.url);
const roleDirectory = '.agents/agents/codex-polish-editor';
const roleFile = roleDirectory + '/agent.md';
const paths = ['.', '.agents', '.agents/agents', roleDirectory, roleFile, '.acp-in', '.acp-out', '.acp-owner', '.acp-jobs', '.acp-display'];
const authMethods = ['existing-session', 'gemini-api-key', 'agent-platform'];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const identity = info => info && `${info.dev}:${info.ino}`;
const statEntry = path => fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
const { O_NONBLOCK, O_NOFOLLOW, O_WRONLY, O_RDONLY } = fs.constants;

function checkWorkspace(token) {
  const parts = token?.split(',');
  if (![3, 4].includes(parts?.length) || parts.some(p => !/^\d+:\d+$/.test(p)) || identity(statEntry('.')) !== parts[0])
    throw new Error('invalid_workspace');
  return { fifo: parts[1], owner: parts[2], display: parts[3] };
}

function openDisplay(token, flags) {
  const { display } = checkWorkspace(token);
  if (!display) throw new Error('missing_display_pipe');
  const fd = fs.openSync('.acp-display', flags | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFIFO() || identity(stat) !== display) throw new Error('workspace_changed');
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}

// An O_RDWR reader can open before the submitter; one LF delimits its only record.
export const openDisplayInput = token => openDisplay(token, fs.constants.O_RDWR);
export const openDisplayOutput = token => openDisplay(token, O_WRONLY);

function linkOwner(name, owner) {
  if (identity(statEntry('.acp-owner')) !== owner) throw new Error('workspace_changed');
  fs.linkSync('.acp-owner', name);
}

function activate(token, jobsFile) {
  const { owner } = checkWorkspace(token);
  if (jobsFile !== undefined && [3, 4].some(fd => identity(fs.fstatSync(fd, { bigint: true })) !== jobsFile))
    throw new Error('workspace_changed');
  linkOwner('.acp-live', owner);
}

export function claimPrompt(token, sessionId) {
  const { owner } = checkWorkspace(token);
  linkOwner('.acp-prompt', owner);
  const fd = fs.openSync('.acp-prompt', O_WRONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    if (identity(fs.fstatSync(fd, { bigint: true })) !== owner) throw new Error('workspace_changed');
    fs.writeFileSync(fd, sessionId);
  } finally { fs.closeSync(fd); }
}

export function submittedPrompt(token) {
  const { owner } = checkWorkspace(token);
  let fd;
  try {
    fd = fs.openSync('.acp-prompt', O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stat = fs.fstatSync(fd, { bigint: true });
    if (identity(stat) !== owner || !stat.isFile() || stat.size > 16384n) throw new Error('workspace_changed');
    return fs.readFileSync(fd, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Bind a single agent-selected producer's stdout to the staged FIFO. Opening
// nonblocking fails immediately when the official process is gone. Only the
// producer handles the bytes, including Node stream backpressure on a big draft.
function writeWithProducer(token, producer, args) {
  const { fifo, owner } = checkWorkspace(token);
  if (identity(statEntry('.acp-live')) !== owner) throw new Error('workspace_inactive');
  const fd = fs.openSync('.acp-in', O_WRONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (identity(stat) !== fifo || !stat.isFIFO()) throw new Error('workspace_changed');
    const options = { stdio: [0, fd, 'ignore'] };
    if (producer === 'frame' && args.length === 1) {
      execFileSync('/usr/bin/printf', ['%s\n', args[0]], { ...options, timeout: 30000, killSignal: 'SIGKILL' });
      return;
    }
    if (producer !== 'prompt' || !args.includes('--submit') || args.includes('--help') || args.includes('-h')) throw new Error('invalid_producer');
    execFileSync(process.execPath, [fileURLToPath(new URL('acp_payload.mjs', import.meta.url)), ...args], {
      ...options, env: { ...process.env, CODEX_POLISH_WRITE_TOKEN: token },
    });
  } finally { fs.closeSync(fd); }
}

// Compare the staged directory and every ancestor before touching known entries.
// rmdir leaves directories containing files owned by the provider or another job.
function dispose(workspace, owners) {
  if (dirname(workspace) !== fs.realpathSync(tmpdir()) || !/^codex-polish-acp-[A-Za-z0-9]{6}$/.test(basename(workspace))) return;
  const intact = new Set();
  for (const [index, name] of paths.entries()) {
    if (name !== '.' && !intact.has(dirname(name))) continue;
    const current = statEntry(join(workspace, name));
    if (current && !current.isSymbolicLink() && identity(current) === owners[index]) intact.add(name);
  }
  if (!intact.has('.')) return;
  // Anchor each unlink/rmdir to the verified parent directory. Even a rename
  // between the ancestry check and chdir cannot redirect removal outside it.
  const previous = process.cwd();
  const parentId = identity(statEntry(dirname(workspace)));
  const remove = (name, expected) => {
    const absolute = join(workspace, name);
    const expectedParent = name === '.' ? parentId : owners[paths.indexOf(dirname(name))];
    try {
      process.chdir(dirname(absolute));
      if (identity(statEntry('.')) !== expectedParent) return;
      const leaf = basename(absolute);
      const current = statEntry(leaf);
      if (!current || identity(current) !== expected) return;
      if (current.isDirectory()) fs.rmdirSync(leaf);
      else fs.unlinkSync(leaf);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ELOOP', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
  };
  try {
    for (const link of ['.acp-prompt', '.acp-live']) remove(link, owners[paths.indexOf('.acp-owner')]);
    for (const name of [...intact].reverse()) remove(name, owners[paths.indexOf(name)]);
  } finally {
    if (previous !== workspace || fs.existsSync(previous)) process.chdir(previous);
  }
}

function catalogDestination(file) {
  if (!isAbsolute(file)) throw new Error('invalid_catalog_log');
  const directory = fs.realpathSync(dirname(file));
  const info = fs.statSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('invalid_catalog_log');
  const destination = join(directory, basename(file));
  if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw new Error('invalid_catalog_log');
  return destination;
}

export function prepareWorkspace({ agyPath, cwd, trigger, selectionOnly, selection, turnsBack, noHistory,
  auth, model, route, rewriteMode, display, quotedSource, catalog, catalogLog }) {
  if (!agyPath || !isAbsolute(agyPath) || basename(agyPath) !== 'agy' || !fs.statSync(agyPath).isFile()) throw new Error('invalid_agy_path');
  fs.accessSync(agyPath, fs.constants.X_OK);
  if (!authMethods.includes(auth)) throw new Error('invalid_auth');
  if (catalog ? (cwd || trigger || selectionOnly || selection || noHistory || turnsBack !== undefined || model || route || rewriteMode || display !== undefined || quotedSource) :
      (!cwd || !isAbsolute(cwd) || !['auto', 'explicit'].includes(trigger) || !validModelId(model) || catalogLog !== undefined ||
      !['normal', 'turbo'].includes(rewriteMode) || !['acp', 'decisions'].includes(route) || !['zh', 'en', 'body-only'].includes(display)))
    throw new Error('invalid_options');
  if ((turnsBack !== undefined && (!Number.isSafeInteger(turnsBack) || turnsBack < 1)) ||
      [Boolean(selection), Boolean(selectionOnly), turnsBack !== undefined].filter(Boolean).length > 1 ||
      (quotedSource && turnsBack !== undefined) || ((selection || selectionOnly || turnsBack !== undefined) && trigger !== 'explicit'))
    throw new Error('invalid_target');
  const observeArgs = ['--auth', auth];
  if (catalog) {
    observeArgs.push('--catalog');
    if (catalogLog !== undefined) observeArgs.push('--catalog-log', catalogDestination(catalogLog));
  } else {
    observeArgs.push('--model', model, '--display', display);
    if (quotedSource) observeArgs.push('--quoted-source');
  }
  const role = catalog ? fs.readFileSync(stockRole) : editorRole(cwd, trigger, { selectionOnly });
  const workspace = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'codex-polish-acp-'));
  const owners = [];
  const record = name => { owners[paths.indexOf(name)] = identity(statEntry(join(workspace, name))); };
  try {
    record('.');
    for (const dir of ['.agents', '.agents/agents', roleDirectory]) {
      fs.mkdirSync(join(workspace, dir), { mode: 0o700 });
      record(dir);
    }
    const roleFd = fs.openSync(join(workspace, roleFile), 'wx', 0o600);
    try { record(roleFile); fs.writeFileSync(roleFd, role); }
    finally { fs.closeSync(roleFd); }
    const pipes = ['.acp-in', '.acp-out'];
    if (!catalog) pipes.push('.acp-display');
    for (const fifo of pipes) {
      execFileSync('/usr/bin/mkfifo', ['-m', '600', join(workspace, fifo)], { stdio: 'ignore' });
      record(fifo);
    }
    for (const name of ['.acp-owner', '.acp-jobs']) {
      fs.closeSync(fs.openSync(join(workspace, name), 'wx', 0o600));
      record(name);
    }
    const tokenPaths = ['.', '.acp-in', '.acp-owner'];
    if (!catalog) tokenPaths.push('.acp-display');
    const token = tokenPaths.map(name => owners[paths.indexOf(name)]).join(',');
    observeArgs.push('--workspace-token', token);
    if (!catalog) {
      const payloadArgs = ['--cwd', cwd, '--editor-role-file', join(workspace, roleFile), '--trigger', trigger,
        '--route', route, '--rewrite-mode', rewriteMode, '--model', model];
      if (selectionOnly) payloadArgs.push('--selection-only');
      if (selection) payloadArgs.push('--selection');
      if (noHistory) payloadArgs.push('--no-history');
      if (turnsBack !== undefined) payloadArgs.push('--turns-back', String(turnsBack));
      observeArgs.push('--payload-args', JSON.stringify(payloadArgs));
    }
    const cmd = [
      `[ . -ef ${quote(workspace)} ] || exit 1`,
      `acp_activate() ( trap '' HUP INT TERM; exec ${quote(process.execPath)} ${quote(self)} --activate ${quote(token)} ${quote(owners[paths.indexOf('.acp-jobs')])}; )`,
      `acp_dispose() { ${quote(process.execPath)} ${quote(self)} --dispose ${quote(workspace)} ${quote(owners.join(','))}; }`,
      `. ${quote(terminal)} || exit 1`,
      `CODEX_POLISH_SUPERVISOR_PID=$$ ${[process.execPath, observer, ...observeArgs].map(quote).join(' ')} < .acp-out 3>&- 4<&- &`,
      'acp_observer=$!',
      `${quote(agyPath)} acp --agent codex-polish-editor --sandbox 0<>.acp-in > .acp-out 2>/dev/null 3>&- 4<&- &`,
      'acp_provider=$!',
      'acp_wait',
    ].join('\n');
    return { workspace, fifo: join(workspace, '.acp-in'), editor_role_file: join(workspace, roleFile), write_token: token,
      start: { cmd, workdir: workspace, shell: '/bin/sh', login: false, tty: true, yield_time_ms: 250, max_output_tokens: 32768 } };
  } catch (error) {
    dispose(workspace, owners);
    throw error;
  }
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv[2] === '--write') writeWithProducer(process.argv[3], process.argv[4], process.argv.slice(5));
    else if (process.argv[2] === '--activate' && [4, 5].includes(process.argv.length)) activate(process.argv[3], process.argv[4]);
    else if (process.argv[2] === '--dispose' && process.argv.length === 5) dispose(process.argv[3], process.argv[4].split(','));
    else {
      const { values } = parseArgs({ options: {
        'agy-path': { type: 'string' }, cwd: { type: 'string' }, trigger: { type: 'string' }, 'selection-only': { type: 'boolean' },
        selection: { type: 'boolean' }, 'no-history': { type: 'boolean' }, 'turns-back': { type: 'string' },
        'rewrite-mode': { type: 'string' }, route: { type: 'string' },
        display: { type: 'string' }, 'quoted-source': { type: 'boolean' },
        auth: { type: 'string' }, model: { type: 'string' }, catalog: { type: 'boolean' }, 'catalog-log': { type: 'string' },
      } });
      console.log(JSON.stringify(prepareWorkspace({ agyPath: values['agy-path'], cwd: values.cwd, trigger: values.trigger,
        selection: values.selection, noHistory: values['no-history'], turnsBack: values['turns-back'] === undefined ? undefined : Number(values['turns-back']),
        route: values.route, rewriteMode: values['rewrite-mode'], display: values.display, quotedSource: values['quoted-source'],
        selectionOnly: values['selection-only'], auth: values.auth, model: values.model, catalog: values.catalog, catalogLog: values['catalog-log'] })));
    }
  } catch {
    process.stderr.write(process.argv[2] === '--write' ? 'acp_write_failed\n' : 'acp_start_failed\n');
    process.exitCode = 1;
  }
}
