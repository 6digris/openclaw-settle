"""Real Win32 console events and native task/process observations. No POSIX emulation."""
import ctypes
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from identity import require


def powershell(script, *args, check=True):
    # Static script; values arrive in process environment, never executable interpolation.
    env = dict(os.environ)
    for index, value in enumerate(args):
        env['PR147054_ARG_' + str(index)] = str(value)
    p = subprocess.run(['pwsh', '-NoProfile', '-NonInteractive', '-Command', script],
                       capture_output=True, text=True, timeout=60, env=env)
    require(not check or p.returncode == 0, 'Native query failed: ' + p.stderr[-1000:])
    return p


def processes():
    p = powershell("$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | "
                   "Select-Object Name,ProcessId,ParentProcessId,CreationDate,CommandLine) | ConvertTo-Json -Compress")
    rows = json.loads(p.stdout or '[]')
    return rows if isinstance(rows, list) else [rows]


def owned(root):
    # Package is installed uniquely inside the fresh work root; never a shared installation.
    needle = str(Path(root).resolve()).casefold()
    rows = processes()
    found = {p['ProcessId']: p for p in rows
             if p.get('Name', '').casefold() in ('node.exe', 'cmd.exe', 'wscript.exe', 'cscript.exe')
             and needle in (p.get('CommandLine') or '').casefold()
             and p['ProcessId'] != os.getpid()}
    for _ in range(12):
        for p in rows:
            if p['ParentProcessId'] in found and p['ProcessId'] != os.getpid():
                found[p['ProcessId']] = p
    return found


def alive(identity):
    return any(p['ProcessId'] == identity['ProcessId'] and
               p['CreationDate'] == identity['CreationDate'] for p in processes())


def kill_owned(identity, root):
    # Recheck start identity atomically in the native script before opening/stopping the PID.
    script = """
$ErrorActionPreference='Stop'
$i=$env:PR147054_ARG_0 | ConvertFrom-Json
$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$i.ProcessId)
if ($null -eq $p) { exit 0 }
$actual=$p | Select-Object Name,ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress | ConvertFrom-Json
if ($actual.CreationDate -cne $i.CreationDate -or $actual.CommandLine -cne $i.CommandLine) { throw 'PID identity changed' }
$process=Get-Process -Id $i.ProcessId
# Win32_Process exposes microseconds; compare the opened handle at the same precision.
$handleTicks=$process.StartTime.ToUniversalTime().Ticks
$cimTicks=([datetime]$i.CreationDate).ToUniversalTime().Ticks
if (($handleTicks - ($handleTicks % 10)) -ne ($cimTicks - ($cimTicks % 10))) { throw 'Process handle start identity changed' }
$process.Kill()
if (-not $process.WaitForExit(10000)) { throw 'Owned process did not exit' }
"""
    return powershell(script, json.dumps(identity), str(root))


def task_xml(name):
    # Enumerate successfully then compare the exact name: query errors are not absence.
    p = powershell("$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); "
                   "$tasks=@($s.GetFolder('\\').GetTasks(0)); "
                   "$t=@($tasks | Where-Object {$_.Name -ceq $env:PR147054_ARG_0}); "
                   "if($t.Count -gt 1){throw 'Ambiguous task'}; "
                   "if($t.Count -eq 1){$t[0].Xml}", name)
    return p.stdout.strip()


def remove_task(name, root):
    xml = task_xml(name)
    if not xml:
        return
    # The CLI-created action points at the fixture's isolated state gateway.vbs.
    require(str(Path(root).resolve()).casefold() in xml.casefold(),
            'Task action is not owned by this fixture')
    powershell("$ErrorActionPreference='Stop'; $t=Get-ScheduledTask -TaskName $env:PR147054_ARG_0 -TaskPath '\\'; "
               "Stop-ScheduledTask -InputObject $t; Unregister-ScheduledTask -InputObject $t -Confirm:$false", name)
    require(not task_xml(name), 'Task still registered')


def listener(port):
    p = powershell("$ErrorActionPreference='Stop'; @(Get-NetTCPConnection -State Listen | "
                   "Where-Object {$_.LocalPort -eq [int]$env:PR147054_ARG_0} | "
                   "Select-Object -ExpandProperty OwningProcess -Unique) | ConvertTo-Json -Compress", port)
    ids = json.loads(p.stdout or '[]')
    return ids if isinstance(ids, list) else [ids]


def console_event(pid, event):
    require(sys.platform == 'win32', 'Native Windows required')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.FreeConsole.argtypes = []
    kernel.FreeConsole.restype = ctypes.c_int
    kernel.AttachConsole.argtypes = [ctypes.c_uint32]
    kernel.AttachConsole.restype = ctypes.c_int
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_uint32)
    callback = callback_type(lambda signal: 1)
    kernel.SetConsoleCtrlHandler.argtypes = [callback_type, ctypes.c_int]
    kernel.SetConsoleCtrlHandler.restype = ctypes.c_int
    kernel.GenerateConsoleCtrlEvent.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
    kernel.GenerateConsoleCtrlEvent.restype = ctypes.c_int
    kernel.FreeConsole()
    require(kernel.AttachConsole(pid), 'AttachConsole failed')
    try:
        require(kernel.SetConsoleCtrlHandler(callback, 1), 'Protect console sender failed')
        require(kernel.GenerateConsoleCtrlEvent(event, 0), 'GenerateConsoleCtrlEvent failed')
        time.sleep(.2)
    finally:
        kernel.FreeConsole()
    print(json.dumps({'api': 'GenerateConsoleCtrlEvent', 'event': event, 'targetPid': pid, 'success': True}))


if __name__ == '__main__':
    console_event(int(sys.argv[1]), int(sys.argv[2]))
