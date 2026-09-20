"""Installed Gateway lifecycle proof. Windows-only execution, isolated synthetic provider."""
import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from identity import digest, require, save, snapshot, verify_archive, verify_seal
import windows_native as native
import profile_home

DRIVER = Path(__file__).resolve().parent
MODEL = 'proof-native-drain'
MARKER = 'PR147054_PACKAGED_ADMITTED_EFFECT_COMPLETED'
TOKEN = 'pr147054-isolated-synthetic-token'


def now():
    return datetime.now(timezone.utc).isoformat()


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def wait_for(operation, timeout, message):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = operation()
        if value:
            return value
        time.sleep(.1)
    raise RuntimeError(message)


def health(port):
    try:
        for route in ('healthz', 'readyz'):
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/{route}', timeout=2) as resp:
                if resp.status != 200:
                    return False
        return {'health': 200, 'ready': 200}
    except (OSError, urllib.error.URLError):
        return False


def admission(path, prompt):
    if not path.exists():
        return None
    for line in path.read_text(encoding='utf-8').splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        body = item.get('body', {})
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except json.JSONDecodeError:
                continue
        if (item.get('method') == 'POST' and item.get('path') == '/v1/responses'
                and isinstance(body, dict) and body.get('model') == MODEL
                and prompt in json.dumps(body.get('input', []), ensure_ascii=False)):
            return {'seq': item['seq'], 'method': item['method'], 'path': item['path'],
                    'model': body['model'], 'prompt': prompt}
    return None


def join_child(child, timeout=10):
    if child is None:
        return
    try:
        child.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=10)


def bounded_env(cell, profile):
    # Only OS/tool discovery; no operator OpenClaw/provider/Node settings are inherited.
    names = ('SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'ProgramData',
             'ProgramFiles', 'ProgramFiles(x86)', 'SystemDrive')
    env = {key: value for key, value in os.environ.items()
           if key.casefold() in {name.casefold() for name in names}}
    env.update(HOME=str(cell / 'home'), USERPROFILE=str(cell / 'home'),
               APPDATA=str(cell / 'appdata'), LOCALAPPDATA=str(cell / 'localappdata'),
               TEMP=str(cell / 'tmp'), TMP=str(cell / 'tmp'),
               OPENCLAW_STATE_DIR=str(cell / 'state'),
               OPENCLAW_CONFIG_PATH=str(cell / 'state/openclaw.json'), OPENCLAW_PROFILE=profile,
               NODE_COMPILE_CACHE=str(cell / 'cache'), OPENCLAW_SKIP_CHANNELS='1',
               OPENCLAW_SKIP_STARTUP_MODEL_PREWARM='1', OPENAI_API_KEY='synthetic-proof-only',
               NO_COLOR='1', PYTHONDONTWRITEBYTECODE='1')
    return env


def capture_probe_environment_diagnostics(cli, package, task, env, cell):
    # Failure-only comparisons, not a retry or an environment change for the proof.
    # Bracket variants with the original env so cache warm-up cannot masquerade as a fix.
    native_keys = ('LOCALAPPDATA', 'APPDATA', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE',
                   'HOMEPATH', 'ALLUSERSPROFILE', 'ProgramW6432', 'CommonProgramFiles',
                   'CommonProgramFiles(x86)', 'CommonProgramW6432', 'PSModuleAnalysisCachePath')
    source = {key.casefold(): (key, value) for key, value in os.environ.items()
              if key.casefold() in {name.casefold() for name in native_keys}}
    script = """
import {pathToFileURL} from 'node:url';
const m = await import(pathToFileURL(process.argv[1]));
const started = performance.now();
const state = m._(process.argv[2], 5000);
console.log(JSON.stringify({state, elapsedMs: performance.now() - started, probeBudgetMs: 5000}));
"""
    args = [cli[0], '--input-type=module', '-e', script,
            str(package / 'dist/schtasks-layout-ClZuVTuI.mjs'), task]
    rows = []
    for label, keys in (('baseline-before', ()), ('native-localappdata', ('LOCALAPPDATA',)),
                        ('baseline-between', ()), ('native-bootstrap', native_keys),
                        ('baseline-after', ())):
        child_env = dict(env)
        restored = []
        for name in keys:
            inherited = source.get(name.casefold())
            if inherited is None:
                continue
            key, value = inherited
            if any(k.casefold() == key.casefold() and v == value
                   for k, v in child_env.items()):
                continue
            child_env = {k: v for k, v in child_env.items() if k.casefold() != key.casefold()}
            child_env[key] = value
            restored.append(key)
        row = {'label': label, 'restoredKeys': restored, 'probeBudgetMs': 5000}
        started = time.monotonic()
        try:
            p = subprocess.run(args, capture_output=True, text=True, env=child_env,
                               cwd=cell, timeout=30)
            row.update(exitCode=p.returncode, stdout=p.stdout, stderr=p.stderr)
        except Exception as exc:
            row['error'] = type(exc).__name__ + ': ' + str(exc)
        row['elapsedMs'] = (time.monotonic() - started) * 1000
        rows.append(row)
    return {'scope': 'read-only failure diagnostics; never lifecycle acceptance', 'probes': rows}


def capture_install_diagnostics(cli, package, task, env, cell):
    # Failure-only, read-only observations. Never retry installation or reinterpret failure.
    module = package / 'dist/schtasks-layout-ClZuVTuI.mjs'
    script = """
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const m = await import(pathToFileURL(process.argv[1]));
const paths = [m.d(process.env), ...m.c(process.env)].map(path => {
  try { const stat = fs.lstatSync(path); return {path, present: true,
    file: stat.isFile(), directory: stat.isDirectory(), symlink: stat.isSymbolicLink()}; }
  catch (error) { return {path, errorCode: error.code}; }
});
const state = m._(process.argv[2]);
let command;
try { command = {readable: true, absent: (await m.o(process.env, {requireEffective: true})) === null}; }
catch (error) { command = {readable: false, error: String(error)}; }
console.log(JSON.stringify({scope: 'read-only after failed install; not lifecycle acceptance',
  state, paths, command}));
"""
    queries = (
        ('installedStatus', cli + ['gateway', 'status', '--json', '--no-probe'], 90),
        ('installedTaskInspection', [cli[0], '--input-type=module', '-e', script,
                                     str(module), task], 30),
    )
    result = {}
    for name, args, timeout in queries:
        try:
            p = subprocess.run(args, capture_output=True, text=True, env=env,
                               cwd=cell, timeout=timeout)
            result[name] = {'exitCode': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr}
        except Exception as exc:
            result[name] = {'error': type(exc).__name__ + ': ' + str(exc)}
    try:
        result['probeEnvironment'] = capture_probe_environment_diagnostics(cli, package, task, env, cell)
    except Exception as exc:
        result['probeEnvironment'] = {'error': type(exc).__name__ + ': ' + str(exc)}
    return result


def cleanup(root, owner, row):
    errors = []
    def attempt(name, operation):
        try:
            return operation()
        except Exception as exc:
            errors.append(name + ': ' + str(exc))
    # Independent phases: a failed discovery cannot skip native task removal.
    for task in owner['tasks']:
        attempt('remove task ' + task, lambda task=task: native.remove_task(task, root))
    processes = attempt('discover owned processes', lambda: native.owned(root)) or {}
    for identity in processes.values():
        attempt('join PID ' + str(identity['ProcessId']),
                lambda identity=identity: native.kill_owned(identity, root))
    remaining = attempt('verify no processes', lambda: native.owned(root))
    if remaining is None or remaining:
        errors.append('Process absence unverified')
    tasks = attempt('verify no tasks', lambda: {task: native.task_xml(task) for task in owner['tasks']})
    if tasks is None or any(tasks.values()):
        errors.append('Task absence unverified')
    for port in owner.get('ports', []):
        try:
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', port))
        except OSError as exc:
            errors.append('Port not released: ' + str(port) + ': ' + str(exc))
    profile_cleanup = None
    if not errors:
        profile_cleanup = attempt('retire canonical profile alias', lambda: profile_home.retire(root, owner))
    row['canonicalProfileCleanup'] = profile_cleanup
    row.setdefault('cleanupAttempts', []).append({'at': now(), 'errors': list(errors)})
    row['cleanup'] = {'at': now(), 'errors': errors,
                      'remainingProcesses': remaining, 'tasks': tasks}
    return not errors


def run_cell(root, seal, mode, owner):
    cell = root / mode
    cell.mkdir()
    for name in ('home', 'appdata', 'localappdata', 'tmp', 'state', 'workspace', 'cache'):
        (cell / name).mkdir()
    profile = owner['profiles'][mode]
    task = 'OpenClaw Gateway (' + profile + ')'
    env = bounded_env(cell, profile)
    node = seal['node']
    package = root / 'runtime/node_modules/openclaw'
    cli = [node, str(package / 'openclaw.mjs')]
    row = {'mode': mode, 'startedAt': now(), 'state': 'RUNNING'}
    mock = gateway = request_thread = None
    logs = []
    result = {}
    request_error = []
    tracked = {}
    # Handled POSIX-style Python interrupts are deferred through every ownership transfer.
    interrupted = []
    previous = {}
    def on_signal(signum, _frame):
        interrupted.append(signum)
    def checkpoint():
        require(not interrupted, 'Interrupted: ' + str(interrupted))
    def spawn(args, **kwargs):
        child = subprocess.Popen(args, **kwargs)
        return child
    def command(args, timeout=90):
        p = subprocess.run(cli + args, capture_output=True, text=True, env=env,
                           cwd=cell, timeout=timeout)
        require(p.returncode == 0, 'Installed CLI failed: ' + p.stdout[-1500:] + p.stderr[-1500:])
        return p
    def rpc(method, params):
        return command(['gateway', 'call', method, '--params', json.dumps(params),
                        '--url', f'ws://127.0.0.1:{gport}', '--token', TOKEN, '--json'], 60)
    def discover():
        found = native.owned(root)
        if mock is not None:
            found.pop(mock.pid, None)
        tracked.update(found)
        return found
    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous[signum] = signal.signal(signum, on_signal)
        gport, mport = free_port(), free_port()
        while mport == gport:
            mport = free_port()
        owner['ports'].extend([gport, mport])
        save(root / 'OWNER.json', owner)
        cfg = {'agents': {'defaults': {'workspace': str(cell / 'workspace')}},
               'logging': {'file': str(cell / 'gateway.log'), 'level': 'debug'},
               'gateway': {'mode': 'local', 'bind': 'loopback', 'port': gport,
                           'auth': {'mode': 'token', 'token': TOKEN}, 'controlUi': {'enabled': False},
                           'http': {'endpoints': {'responses': {'enabled': True}}}}}
        save(cell / 'input-config.json', cfg)
        js = "import fs from 'node:fs'; import {applyMockOpenAiModelConfig} from './scripts/e2e/lib/fixtures/mock-openai-config.mjs'; const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); applyMockOpenAiModelConfig(c,{mockPort:Number(process.argv[3]),modelRef:'openai/proof-native-drain'}); c.models.providers.openai.apiKey='synthetic-proof-only'; fs.writeFileSync(process.argv[2],JSON.stringify(c));"
        subprocess.run([node, '--input-type=module', '-e', js, str(cell / 'input-config.json'),
                        str(cell / 'state/openclaw.json'), str(mport)],
                       cwd=DRIVER / 'fixture-source', env=env, check=True, timeout=30)
        save(cell / 'response-control.json', {'hold': True, 'text': MARKER})
        mock_log = (cell / 'mock.log').open('w', encoding='utf-8'); logs.append(mock_log)
        mock = spawn([node, str(DRIVER / 'fixture-source/scripts/e2e/mock-openai-server.mjs'),
                      '--pr147054-owned-root', str(root)],
                     cwd=cell, env=env | {'MOCK_PORT': str(mport),
                      'MOCK_RESPONSE_CONTROL': str(cell / 'response-control.json'),
                      'MOCK_REQUEST_LOG': str(cell / 'mock-requests.jsonl')},
                     stdout=mock_log, stderr=subprocess.STDOUT)
        checkpoint()
        def mock_ready():
            checkpoint()
            require(mock.poll() is None, 'Mock exited')
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{mport}/health', timeout=2) as r:
                    return r.status == 200
            except (OSError, urllib.error.URLError):
                return False
        wait_for(mock_ready, 30, 'Mock not ready')
        if mode == 'scheduled-task':
            row['canonicalProfile'] = profile_home.claim(root, owner, node, env)
            require(not native.task_xml(task), 'Fixture task already exists')
            owner['tasks'].append(task); save(root / 'OWNER.json', owner)
            try:
                row['install'] = command(['gateway', 'install', '--port', str(gport),
                                          '--runtime', 'node', '--runtime-path', node, '--json']).stdout
            except Exception:
                row['installDiagnostics'] = capture_install_diagnostics(cli, package, task, env, cell)
                raise
            xml = native.task_xml(task)
            require(xml and str(root).casefold() in xml.casefold(), 'Native task absent or action unowned; no Startup fallback acceptance')
            require('<LogonType>InteractiveToken</LogonType>' in xml, 'Not an interactive Scheduled Task')
            (cell / 'task.xml').write_text(xml, encoding='utf-8')
            command(['gateway', 'start', '--json'])
        else:
            out = (cell / 'console.log').open('w', encoding='utf-8'); logs.append(out)
            gateway = spawn(cli + ['gateway', 'run', '--port', str(gport), '--bind', 'loopback'],
                            cwd=cell, env=env, stdout=out, stderr=subprocess.STDOUT,
                            creationflags=subprocess.CREATE_NEW_CONSOLE)
            checkpoint()
        row['initialHealth'] = wait_for(lambda: (checkpoint(), health(gport))[1], 150, 'Gateway not ready')
        initial = discover()
        listener_ids = native.listener(gport)
        require(len(initial) >= 2 and len(listener_ids) == 1 and listener_ids[0] in initial,
                'Listening Gateway is not a tracked recovery process tree')
        listener_identity = initial[listener_ids[0]]
        row['initialProcesses'] = list(initial.values())
        row['initialListener'] = listener_identity
        prompt = 'PR147054_REQUEST_' + uuid.uuid4().hex
        session = 'agent:main:openresponses:pr147054-' + uuid.uuid4().hex
        def request():
            try:
                req = urllib.request.Request(f'http://127.0.0.1:{gport}/v1/responses',
                    data=json.dumps({'model': 'openclaw/main', 'input': prompt, 'stream': False,
                                     'max_output_tokens': 100}).encode(),
                    headers={'authorization': 'Bearer ' + TOKEN, 'content-type': 'application/json',
                             'x-openclaw-agent': 'main', 'x-openclaw-scopes': 'operator.write',
                             'x-openclaw-session-key': session})
                with urllib.request.urlopen(req, timeout=180) as r:
                    result.update(status=r.status, body=r.read().decode())
            except Exception as exc:
                request_error.append(str(exc))
        request_thread = threading.Thread(target=request)
        request_thread.start(); checkpoint()
        def admitted():
            checkpoint()
            require(request_thread.is_alive(), 'Request ended before admission: ' + str(request_error))
            return admission(cell / 'mock-requests.jsonl', prompt)
        row['providerAdmission'] = wait_for(admitted, 60, 'No exact provider admission')
        log = cell / 'gateway.log'
        offset = log.stat().st_size
        def fresh_log():
            with log.open('rb') as stream:
                stream.seek(offset)
                return stream.read().decode('utf-8', errors='replace')
        if mode == 'scheduled-task':
            row['restartReply'] = json.loads(rpc('gateway.restart.request',
                {'reason': 'PR147054 packaged Scheduled Task drain', 'skipDeferral': True}).stdout)
            ack_signal, ack_action = 'received SIGUSR1; restarting', 'draining active work before restart'
        else:
            event = 0 if mode == 'ctrl-c' else 1
            p = subprocess.run([sys.executable, '-B', str(DRIVER / 'windows_native.py'),
                                str(gateway.pid), str(event)], capture_output=True, text=True, timeout=15)
            require(p.returncode == 0, 'Native console event failed: ' + p.stderr)
            row['nativeEvent'] = json.loads(p.stdout)
            ack_signal, ack_action = 'received SIGINT; shutting down', 'draining active work before stop'
        def acknowledged():
            checkpoint()
            require(request_thread.is_alive(), 'Request ended before acknowledged drain')
            text = fresh_log()
            return text if ack_signal in text and ack_action in text else None
        row['shutdownAcknowledgement'] = wait_for(acknowledged, 30, 'No Gateway shutdown/drain acknowledgement')
        started = time.monotonic()
        while time.monotonic() - started < 3.3:
            checkpoint()
            require(request_thread.is_alive(), 'Admitted request died during held drain')
            require(native.alive(listener_identity), 'Gateway died during held drain')
            time.sleep(.1)
        row['releaseAfterAcknowledgedShutdownMs'] = (time.monotonic() - started) * 1000
        save(cell / 'response-control.json', {'hold': False, 'text': MARKER})
        request_thread.join(65)
        require(not request_thread.is_alive(), 'Request did not finish')
        row['httpResult'] = result
        require(not request_error and result.get('status') == 200 and MARKER in result.get('body', ''),
                'Admitted request failed: ' + str(request_error))
        wait_for(lambda: not native.alive(listener_identity), 40, 'Old listening process survived')
        if gateway is not None:
            gateway.wait(timeout=30)
            wait_for(lambda: not {pid: item for pid, item in native.owned(root).items() if pid != mock.pid},
                     30, 'Old console process tree survived')
            out = (cell / 'replacement-console.log').open('w', encoding='utf-8'); logs.append(out)
            verify_seal(root, DRIVER, owner['sealSha256'])
            gateway = spawn(cli + ['gateway', 'run', '--port', str(gport), '--bind', 'loopback'],
                            cwd=cell, env=env, stdout=out, stderr=subprocess.STDOUT,
                            creationflags=subprocess.CREATE_NEW_CONSOLE)
            checkpoint()
        row['replacementHealth'] = wait_for(lambda: (checkpoint(), health(gport))[1], 150, 'Replacement not ready')
        replacement = discover()
        new_ids = native.listener(gport)
        require(len(new_ids) == 1 and new_ids[0] in replacement and new_ids[0] != listener_identity['ProcessId'],
                'Gateway was not actually replaced')
        row['replacementListener'] = replacement[new_ids[0]]
        history = rpc('chat.history', {'sessionKey': session, 'limit': 30})
        (cell / 'authenticated-history.json').write_text(history.stdout, encoding='utf-8')
        require(MARKER in history.stdout and prompt in history.stdout, 'Persisted authenticated history missing effect/request')
        row['persistedEffectAfterProcessReplacement'] = True
        verify_seal(root, DRIVER, owner['sealSha256'])
        row['state'] = 'PASS'
    except BaseException as exc:
        row.update(state='FAIL', error=type(exc).__name__ + ': ' + str(exc))
    finally:
        # Cleanup must continue even if a handled signal repeats.
        for signum in previous:
            signal.signal(signum, signal.SIG_IGN)
        errors = []
        def attempt(name, fn):
            try:
                fn()
            except Exception as exc:
                errors.append(name + ': ' + str(exc))
        attempt('release provider', lambda: save(cell / 'response-control.json', {'hold': False, 'text': MARKER}))
        if request_thread is not None and request_thread.ident is not None:
            attempt('join request', lambda: request_thread.join(5))

        attempt('native cleanup', lambda: cleanup(root, owner, row))
        if gateway is not None:
            attempt('join console child', lambda: join_child(gateway))
        if mock is not None:
            attempt('join mock', lambda: join_child(mock, .1))
        if request_thread is not None and request_thread.ident is not None:
            attempt('final request join', lambda: request_thread.join(10))
            if request_thread.is_alive():
                errors.append('Request thread survived')
        for handle in logs:
            attempt('close log', handle.close)
        # Second verification occurs after mock and all retained child handles are joined.
        attempt('post-join native check', lambda: cleanup(root, owner, row))
        if errors or any(item['errors'] for item in row.get('cleanupAttempts', [])):
            row.update(state='FAIL', cleanupErrors=errors)
        row['completedAt'] = now()
        save(cell / 'RESULT.json', row)
        for signum, handler in previous.items():
            signal.signal(signum, handler)
    require(row['state'] == 'PASS', 'Cell failed; see ' + str(cell / 'RESULT.json'))
    return row


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--seal', required=True)
    parser.add_argument('--cleanup-only', action='store_true')
    parser.add_argument('--case', choices=('all', 'scheduled-task'), default='all')
    args = parser.parse_args()
    root = args.root.resolve()
    modes = ('ctrl-c', 'ctrl-break', 'scheduled-task') if args.case == 'all' else ('scheduled-task',)
    result = {'startedAt': now(), 'state': 'FAIL', 'cells': [],
              'scope': 'Full installed Windows Gateway; synthetic provider; native consoles and Scheduler',
              'forcedTaskTerminationIsGracefulProof': False, 'requiredModes': list(modes)}
    try:
        require(sys.platform == 'win32' and sys.dont_write_bytecode, 'Windows and python -B required')
        owner = json.loads((root / 'OWNER.json').read_text(encoding='utf-8'))
        require(owner['root'] == str(root) and owner['sealSha256'] == args.seal and
                owner['pr'] == 147054, 'Wrong ownership receipt')
        if args.cleanup_only:
            require(cleanup(root, owner, result), 'Cleanup incomplete')
            result['state'] = 'CLEANUP_PASS'
        else:
            require(not (root / 'RESULT.json').exists(), 'Do not replay existing proof')
            seal = verify_seal(root, DRIVER, args.seal)
            spec = json.loads((DRIVER / 'spec.json').read_text(encoding='utf-8'))
            result['identity'] = verify_archive(root / 'candidate.tgz', root / 'runtime/node_modules/openclaw', spec)
            for mode in modes:
                verify_seal(root, DRIVER, args.seal)
                result['cells'].append(run_cell(root, seal, mode, owner))
            result['state'] = 'PASS'
    except BaseException as exc:
        result['error'] = type(exc).__name__ + ': ' + str(exc)
    finally:
        result['completedAt'] = now()
        # A wrong build/seal still produces a failure receipt, before any service allocation.
        if root.is_dir():
            save(root / ('CLEANUP.json' if args.cleanup_only else 'RESULT.json'), result)
    print(json.dumps({'state': result['state'], 'root': str(root)}), flush=True)
    return 0 if result['state'] in ('PASS', 'CLEANUP_PASS') else 1


if __name__ == '__main__':
    raise SystemExit(main())
