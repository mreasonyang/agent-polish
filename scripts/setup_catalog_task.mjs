import { readFileSync } from 'node:fs';

const windowsGuide = new URL('../plugins/codex-polish/skills/codex-polish/references/acp-windows.md', import.meta.url);

function shellLiteral(value, platform) {
  return "'" + value.replaceAll("'", platform === 'win32' ? "''" : "'\\''") + "'";
}

function terminalInstructions(agyPath, platform) {
  if (platform === 'win32') {
    // Use the same ConPTY launch command that the Windows terminal test exercises.
    const guide = readFileSync(windowsGuide, 'utf8');
    const command = guide.match(/^```powershell\r?\n([\s\S]+?)\r?\n```\r?$/m)?.[1];
    if (!command?.includes('AGY_PATH_UTF8_BASE64')) throw new Error('missing_windows_acp_launch_command');
    const encodedPath = Buffer.from(agyPath, 'utf8').toString('base64');
    return [
      'Use exec_command with the system Windows PowerShell as shell, login:false, tty:true and the following literal command:',
      command.replace('AGY_PATH_UTF8_BASE64', encodedPath),
      'Wait for acp_console_ready. In this ConPTY, finish each write_stdin JSON frame with the actual ESC character (U+001B) followed by [0;0;10;1;0;1_. This key event supplies one LF. A literal LF on this terminal turns into a carriage return.'
    ].join('\n');
  }
  const executable = shellLiteral(agyPath, platform);
  return [
    'Use exec_command with shell:"/bin/sh", login:false, tty:true and this literal command:',
    'unset OPENAI_API_KEY',
    "stty -icanon -echo -ixon -icrnl -onlcr isig intr '^C' min 1 time 0 && exec " + executable + ' acp --agent codex-polish-editor --sandbox >> provider-output.jsonl',
    'End each write_stdin JSON frame with one LF.'
  ].join('\n');
}

// This command waits for user input on disk independently of the provider terminal.
function waitForChoice(choiceFile, platform) {
  const file = shellLiteral(choiceFile, platform);
  if (platform === 'win32') return [
    '$choice = ' + file,
    'while (-not [IO.File]::Exists($choice)) { if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($choice))) { exit 1 }; Start-Sleep -Milliseconds 200 }',
    '[IO.File]::ReadAllText($choice)'
  ].join('\n');
  return [
    'choice=' + file,
    'while [ ! -f "$choice" ]; do [ -d "${choice%/*}" ] || exit 1; sleep 0.2; done',
    'cat "$choice"'
  ].join('\n');
}

export function createCatalogTask({ agyPath, authMethod, workspace, choiceFile, platform = process.platform }) {
  const cwd = JSON.stringify(workspace.workspace);
  const output = JSON.stringify(workspace.output_file);
  let authenticate;
  if (authMethod === 'existing-session') {
    authenticate = 'Use the existing login and proceed directly to session/new.';
  } else if (['gemini-api-key', 'agent-platform'].includes(authMethod)) {
    const method = JSON.stringify(authMethod);
    authenticate = 'Verify authMethods advertises ' + method + ', then send id 2 authenticate with methodId ' + method + ' and wait for success. The provider reads its own credentials.';
  } else {
    throw new Error('unsupported_google_auth');
  }
  return [
    'You are the Codex agent for an interactive Gemini model picker. Only query account configuration. Never send session/prompt or change the thinking level.',
    'The installer has already prepared the role and the private output file. Start exactly one official agy acp process yourself in workdir ' + cwd + '. Retain its terminal session_id and send every JSON-RPC frame directly to that terminal using write_stdin. No script, pipe or relay may operate its input.',
    terminalInstructions(agyPath, platform),
    'Read complete UTF-8 JSON lines from the regular output file ' + output + '. A local read-only command may filter for response IDs and print just the needed fields. Wait for the matching reply, skip notifications and keep incomplete tail lines for the next read. Decline session/request_permission and return -32601 for other unsupported server requests.',
    'Send id 1 initialize with {"protocolVersion":1,"clientCapabilities":{}}. Verify protocolVersion 1. ' + authenticate,
    'Send id 3 session/new with cwd ' + cwd + ' and mcpServers:[]; keep the returned sessionId and category=model selector from configOptions. Leave this process open while the installer shows that list.',
    'Read the installer’s choice with this single blocking exec_command, in a separate shell of the same kind. Allow the maximum tool wait. If the tool yields keep waiting on that same handle, even if the user pauses. This command only reads the menu choice:',
    waitForChoice(choiceFile, platform),
    'If the choice is {"close":true}, finish without switching. For {"model":"…"}, verify the model is an advertised option, send id 4 session/set_config_option on the same sessionId using the model selector’s actual configId and the chosen value, then confirm it in the reply. The installer reads the thinking levels directly from that reply.',
    'Finish promptly. If session/close is supported send id 7 with the open sessionId, then terminate your own foreground PTY with Ctrl-C and confirm exit. On error also terminate your process. The installer removes its workspace. Reply OK on success or briefly explain the failure.'
  ].join('\n');
}
