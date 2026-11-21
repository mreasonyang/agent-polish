// Stage only the editor role. The Codex agent owns the provider process and its streams.
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { openRegular } from '../../../hooks/platform.mjs';
import { isMain } from './cli_io.mjs';
import { secureDirectory } from './acp_windows_io.mjs';
import { editorRole } from './editor_role.mjs';

const roleDirectory = '.agents/agents/codex-polish-editor';
const roleFile = roleDirectory + '/agent.md';
const roleDirectories = ['.agents', '.agents/agents', roleDirectory];
const windowsOutput = 'provider-output.jsonl';
const windows = process.platform === 'win32';
const entries = ['.', ...roleDirectories, roleFile, ...(windows ? [windowsOutput] : [])];
const stockRole = new URL('../references/codex-polish-editor.md', import.meta.url);

function fileId(stat) {
  // Windows may report different volume serials for an open handle and its path.
  return windows ? `${stat.ino}:${stat.birthtimeNs}` : `${stat.dev}:${stat.ino}`;
}

function identity(path) {
  const item = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return item && !item.isSymbolicLink() ? fileId(item) : null;
}

// Never recursively remove the workspace: Antigravity or the user may have added files.
function checkLocation(workspace) {
  if (dirname(workspace) !== fs.realpathSync(tmpdir()) || !/^codex-polish-acp-[a-zA-Z0-9]{6}$/.test(basename(workspace)))
    throw Error('invalid_workspace');
}

function removeOwnedEntries(workspace, owners) {
  checkLocation(workspace);
  const temp = dirname(workspace);
  const previous = process.cwd();
  const tempId = identity(temp);
  const present = new Set();
  try {
    for (const [index, entry] of entries.entries()) {
      if (entry !== '.' && !present.has(dirname(entry))) continue;
      if (owners[index] && identity(join(workspace, entry)) === owners[index]) present.add(entry);
    }
    for (const name of [...present].reverse()) {
      const path = join(workspace, name);
      const parent = name === '.' ? tempId : owners[entries.indexOf(dirname(name))];
      try {
        process.chdir(dirname(path));
        if (identity('.') !== parent || identity(basename(path)) !== owners[entries.indexOf(name)]) continue;
        if (name === roleFile || name === windowsOutput) fs.unlinkSync(basename(path));
        else fs.rmdirSync(basename(path));
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'ELOOP', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      }
    }
  } finally {
    process.chdir(fs.existsSync(previous) ? previous : temp);
  }
}

function recordedOwners(cleanupToken) {
  const owners = cleanupToken.split(',');
  if (owners.length !== entries.length || owners.some(value => !/^\d+:\d+$/.test(value))) throw Error('invalid_cleanup_token');
  return owners;
}

export function dispose(workspace, cleanupToken) {
  removeOwnedEntries(workspace, recordedOwners(cleanupToken));
}

// The terminal on Windows draws a screen. Read the provider's redirected UTF-8 bytes
// from its private regular output file without opening or writing a provider stream.
export function readOutput(workspace, cleanupToken, offset) {
  if (!windows || !Number.isSafeInteger(offset) || offset < 0) throw Error('invalid_output_offset');
  checkLocation(workspace);
  const owners = recordedOwners(cleanupToken);
  if (identity(workspace) !== owners[0]) throw Error('workspace_changed');
  const fd = openRegular(join(workspace, windowsOutput));
  try {
    const info = fs.fstatSync(fd, { bigint: true });
    if (fileId(info) !== owners[entries.indexOf(windowsOutput)] || info.nlink !== 1n || BigInt(offset) > info.size)
      throw Error('output_changed');
    const bytes = Buffer.alloc(8192);
    const count = fs.readSync(fd, bytes, 0, bytes.length, offset);
    // The next call rereads an incomplete final UTF-8 character.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count), { stream: true });
    return { text, next_offset: offset + Buffer.byteLength(text) };
  } finally { fs.closeSync(fd); }
}

export function prepareWorkspace({ cwd, trigger, selectionOnly = false, catalog = false }) {
  if (catalog ? (cwd !== undefined || trigger !== undefined || selectionOnly) :
      (typeof cwd !== 'string' || !isAbsolute(cwd) || !['auto', 'explicit'].includes(trigger) || (selectionOnly && trigger !== 'explicit')))
    throw Error('invalid_options');
  const role = catalog ? fs.readFileSync(stockRole) : editorRole(trigger, { selectionOnly });
  const workspace = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'codex-polish-acp-'));
  const owners = [];
  function createFile(name, contents) {
    const path = join(workspace, name);
    const fd = fs.openSync(path, 'wx', 0o600);
    try {
      owners.push(fileId(fs.fstatSync(fd, { bigint: true })));
      if (contents !== undefined) fs.writeFileSync(fd, contents);
    } finally { fs.closeSync(fd); }
    return path;
  }
  try {
    owners.push(identity(workspace));
    if (windows) secureDirectory(workspace);
    for (const name of roleDirectories) {
      const path = join(workspace, name);
      fs.mkdirSync(path, { mode: 0o700 });
      owners.push(identity(path));
    }
    const editor_role_file = createFile(roleFile, role);
    const output = windows ? { output_file: createFile(windowsOutput) } : {};
    return { workspace, editor_role_file, ...output, cleanup_token: owners.join(',') };
  } catch (error) {
    removeOwnedEntries(workspace, owners);
    throw error;
  }
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv[2] === '--dispose' && process.argv.length === 5) {
      dispose(process.argv[3], process.argv[4]);
    } else if (process.argv[2] === '--read-output' && process.argv.length === 6 && /^\d+$/.test(process.argv[5])) {
      console.log(JSON.stringify(readOutput(process.argv[3], process.argv[4], Number(process.argv[5]))));
    } else {
      const { values } = parseArgs({ options: {
        cwd: { type: 'string' }, trigger: { type: 'string' }, 'selection-only': { type: 'boolean' }, catalog: { type: 'boolean' },
      } });
      console.log(JSON.stringify(prepareWorkspace({ cwd: values.cwd, trigger: values.trigger,
        selectionOnly: values['selection-only'], catalog: values.catalog })));
    }
  } catch {
    process.stderr.write('workspace_operation_failed\n');
    process.exitCode = 1;
  }
}
