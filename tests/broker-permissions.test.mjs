import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { brokerTaskLookupScript } from '../src/windows-broker.mjs';

const run = promisify(execFile);
for (const scenario of [
  { id: 'CmdletizationQuery_NotFound_TaskName', category: 'ObjectNotFound', missing: true },
  { id: 'AccessDenied', category: 'PermissionDenied', missing: false },
  { id: 'TaskServiceUnavailable', category: 'ResourceUnavailable', missing: false },
  { id: 'CommandNotFoundException', category: 'ObjectNotFound', missing: false },
]) {
  test(`broker lookup distinguishes ${scenario.id} from a missing owned task`, { skip: process.platform !== 'win32' }, async () => {
    const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
function Get-ScheduledTask {
  [CmdletBinding()]param([string]$TaskName)
  $record = [System.Management.Automation.ErrorRecord]::new([Exception]::new('Isolated lookup failure.'), '${scenario.id}', [System.Management.Automation.ErrorCategory]::${scenario.category}, $TaskName)
  $PSCmdlet.ThrowTerminatingError($record)
}
try {
${brokerTaskLookupScript('CodexScheduler-permission-fixture')}
  if ($null -ne $task) { throw 'Expected null for an absent task.' }
  [Console]::WriteLine('MISSING'); exit 0
} catch { [Console]::WriteLine('FAIL-CLOSED'); exit 37 }
`;
    let result;
    try { result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 }); }
    catch (error) { result = error; }
    assert.equal(result.code ?? 0, scenario.missing ? 0 : 37);
    assert.match(result.stdout, scenario.missing ? /MISSING/ : /FAIL-CLOSED/);
  });
}
