// Native Windows commands carry only metadata. Private loopback streams use a fresh
// TLS pre-shared key so both peers authenticate before exchanging any application bytes.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import tls from 'node:tls';
import { readInputLine, readLimited } from './cli_io.mjs';

export const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

// Windows PowerShell treats smart quotes as syntax even inside a quoted string.
// Decode unusual arguments as data; never use interpolation or Invoke-Expression.
export function psArg(value) {
  if (/^[\w .:\\/=-]+$/u.test(value)) return "'" + value + "'";
  return "([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(value).toString('base64') + "')))";
}

export function windowsCommand(args, directory) {
  return { shell: powershell, login: false, workdir: directory,
    cmd: '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n& ' +
      args.map(psArg).join(' ') + '\nexit $LASTEXITCODE' };
}

function checkAcl(path, directory, restrict) {
  const script = `$ErrorActionPreference = 'Stop'
$d = Get-Item -Force -LiteralPath ${psArg(path)}
if ($d.PSIsContainer -ne ${directory ? '$true' : '$false'} -or ($d.Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'directory'}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = $d.GetAccessControl()
$trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) {throw 'owner'}
${restrict ? `$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) {$acl.RemoveAccessRuleSpecific($rule)}
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit, ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
$d.SetAccessControl($acl)
$acl = $d.GetAccessControl()` : ''}
$raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
if ($null -eq $raw.DiscretionaryAcl) {throw 'permissions'}
foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value) {throw 'permissions'}
}`;
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
}
export const secureDirectory = path => checkAcl(path, true, true);
export const checkPrivatePath = (path, directory = true) => checkAcl(path, directory, false);

const tlsOptions = { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: 'PSK-AES128-GCM-SHA256', allowHalfOpen: true };

export async function listenPrivate(handle) {
  const key = randomBytes(32);
  const clients = new Set();
  const server = tls.createServer({ ...tlsOptions, handshakeTimeout: 10000,
    pskCallback: (_socket, identity) => identity === 'codex-polish' ? key : null }, async socket => {
    clients.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => clients.delete(socket));
    socket.setTimeout(30000, () => socket.destroy());
    try {
      const raw = await readInputLine(socket, false, true);
      let afterFlush;
      const result = await handle(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)), callback => { afterFlush = callback; });
      socket.end(JSON.stringify(result), () => afterFlush?.());
    } catch { socket.destroy(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return { endpoint: server.address().port + '.' + key.toString('hex'), server,
    close() { server.close(); for (const client of clients) client.destroy(); } };
}

export async function exchange(endpoint, value, limit) {
  if (!/^[1-9]\d{0,4}\.[a-f0-9]{64}$/.test(endpoint)) throw Error('invalid_endpoint');
  const [port, hex] = endpoint.split('.');
  const socket = tls.connect({ ...tlsOptions, port: Number(port), host: '127.0.0.1',
    // PSK ciphers authenticate both Finished messages with the private key; there is no certificate.
    rejectUnauthorized: false, pskCallback: () => ({ identity: 'codex-polish', psk: Buffer.from(hex, 'hex') }) });
  socket.setTimeout(30000, () => socket.destroy(Error('ipc_timeout')));
  try {
    const response = readLimited(socket, limit);
    socket.once('secureConnect', () => socket.write(JSON.stringify(value) + '\n'));
    return JSON.parse((await response).toString('utf8'));
  } finally { socket.destroy(); }
}
