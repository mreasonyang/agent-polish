# Direct ACP on a Windows Codex terminal

When the host exposes raw process streams, launch the official executable with the working directory and argument list from the [ACP workflow](acp.md). Write JSONL to that handle. The instructions below are for hosts that expose only `exec_command` and `write_stdin` with a Windows pseudoconsole (ConPTY).

1. Prepare the workspace. Keep its `workspace`, `editor_role_file`, `output_file` and `cleanup_token`. From outside the workspace, run `node "<scripts>/acp_workspace.mjs" --read-output "<workspace>" "<cleanup_token>" 0` and check for empty `text` and `next_offset: 0`.
2. Call `exec_command` yourself with `workdir` set to the workspace, `tty: true`, `login: false`, the system Windows PowerShell as `shell`, and the command below. Replace `AGY_PATH_UTF8_BASE64` with the Base64 encoding of the UTF-8 absolute `agy.exe` path from the settings check. Use the same literal command for catalog and rewrite sessions. The Win32 calls configure this terminal's input mode. The last native command launches the official executable. Windows redirects only its stdout to the private file, preserving bytes even on Windows PowerShell 5.1.

```powershell
$ErrorActionPreference = 'Stop'
$agy = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('AGY_PATH_UTF8_BASE64'))
Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
Add-Type -Name InputMode -Namespace AcpConsole -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int id);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr handle, out uint mode);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr handle, uint mode);
'@
$handle = [AcpConsole.InputMode]::GetStdHandle(-10)
[uint32]$mode = 0
if (-not [AcpConsole.InputMode]::GetConsoleMode($handle, [ref]$mode)) { throw 'Windows terminal input is unavailable' }
if (-not [AcpConsole.InputMode]::SetConsoleMode($handle, (($mode - ($mode -band 6)) -bor 1))) { throw 'Could not set Windows terminal input mode' }
$env:CODEX_POLISH_NATIVE_COMMAND = '"' + $agy + '" acp --agent codex-polish-editor --sandbox >>provider-output.jsonl'
[Console]::WriteLine('acp_console_ready')
& "$env:SystemRoot\System32\cmd.exe" /d /v:off /c '%CODEX_POLISH_NATIVE_COMMAND%'
exit $LASTEXITCODE
```

3. Wait for `acp_console_ready`. Keep its terminal session ID. Write each ACP frame yourself to that terminal with `write_stdin`. Serialize it once as UTF-8 JSON, then append a single LF (`\n`). Split large inputs across writes at Unicode character boundaries, with the LF only in the last write. Disabling line editing and echo lets the provider consume long frames without putting the draft on screen.
4. For responses, run the same `--read-output` command with the last `next_offset`. Concatenate the returned `text` in order; dispatch complete LF-terminated JSON records. Carry any partial line until the next read. Pages contain at most 8 KiB of original UTF-8. If the offset stays the same the provider has not completed another character yet. Poll with a short pause and check the provider handle for startup or transport errors. Do not resubmit a frame while awaiting its acknowledgement. Only provider output goes in this private file.
5. Follow the ACP workflow for closing or cancelling the session. Stop the foreground terminal after the last response using the host's termination operation, or Ctrl-C (`\u0003` with `write_stdin`), and confirm it exits. Run `--dispose "<workspace>" "<cleanup_token>"` from outside the workspace. The cleanup checks the staged file identities before removing the role and the transient response file.

If the host cannot provide a writable terminal or raw process streams, preserve the draft and report the missing capability.
