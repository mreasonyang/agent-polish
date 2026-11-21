// Windows ACLs for private configuration and temporary role directories.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// Windows PowerShell treats smart quotes as syntax even inside a quoted string.
// Decode unusual arguments as data; never use interpolation or Invoke-Expression.
function psArg(value) {
  if (/^[\w .:\\/=-]+$/u.test(value)) return "'" + value + "'";
  return "([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(value).toString('base64') + "')))";
}

function checkAcl(entries, restrict = false) {
  const script = `$ErrorActionPreference = 'Stop'
function Test-PrivatePath([string]$FilePath,[bool]$Directory) {
$d = if ($Directory) {[IO.DirectoryInfo]::new($FilePath)} else {[IO.FileInfo]::new($FilePath)}
if (!$d.Exists -or ($d.Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'directory'}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = $d.GetAccessControl()
$trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) {throw 'owner'}
${restrict ? `$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in $acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])) {$acl.RemoveAccessRuleSpecific($rule)}
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit, ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
$d.SetAccessControl($acl)
$acl = $d.GetAccessControl()` : ''}
$raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
if ($null -eq $raw.DiscretionaryAcl) {throw 'permissions'}
foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value) {throw 'permissions'}
}
}
${entries.map(({ path, directory }) => 'Test-PrivatePath ' + psArg(path) + (directory ? ' $true' : ' $false')).join('\n')}`;
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
}
export const secureDirectory = path => checkAcl([{ path, directory: true }], true);
export const checkPrivatePaths = entries => checkAcl(entries);
export const checkPrivatePath = (path, directory = true) => checkPrivatePaths([{ path, directory }]);
