"""Bind the temporary hosted witness; a complete diagnostic is not acceptance."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

PAYLOAD = Path(__file__).resolve().parent
OUTPUT = Path('.artifacts/pr144318-crabbox-diagnostic')
SOURCE = '49631111464ff308dbeee93c2a527404748f7563'
FIXTURE = Path('test/scripts/crabbox-staging.test.ts')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def write(name, data):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / name).write_text(json.dumps(data, indent=2) + '\n')


def identity():
    return {
        'source': command('git', 'rev-parse', 'HEAD'),
        'workflowSha': os.environ.get('WORKFLOW_SHA'),
        'runId': os.environ.get('GITHUB_RUN_ID'),
        'attempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
        'jobKey': os.environ.get('GITHUB_JOB'),
        'runner': {key: os.environ.get(key) for key in
                   ['RUNNER_NAME', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_ENVIRONMENT',
                    'ImageOS', 'ImageVersion']},
        'git': command('git', '--version'),
        'cpuCount': os.cpu_count(),
        'memory': Path('/proc/meminfo').read_text().splitlines()[0],
        'payloadHashes': {p.name: digest(p) for p in sorted(PAYLOAD.iterdir()) if p.is_file()},
        'acceptance': False,
    }


mode = sys.argv[1]
if mode == 'prepare':
    manifest = json.loads((PAYLOAD / 'manifest.json').read_text())
    data = identity()
    write('binding.json', data)
    assert data['source'] == SOURCE
    for name, sha in manifest['files'].items():
        if name.endswith(('.mjs', '.patch', '.json')):
            assert digest(PAYLOAD / name) == sha, name
    assert digest(FIXTURE) == manifest['fixturePreimageSha256']
    selection = json.loads((PAYLOAD / 'MAIN22-CRABBOX-ORIGINAL-SELECTION.json').read_text())
    assert selection['head'] == SOURCE and selection['workers'] == 2
    assert selection['node'] == '24.20.0' and len(selection['files']) == 57
    assert len(set(selection['files'])) == 57 and all(Path(f).is_file() for f in selection['files'])
    write('selection.json', selection)
    write('completeness.json', {'complete': False, 'reason': 'diagnostic-not-finished', 'acceptance': False})
elif mode == 'runtime':
    data = identity()
    data.update(node=command('node', '--version'), fixturePreimageSha256=digest(FIXTURE),
                workers=os.environ.get('OPENCLAW_VITEST_MAX_WORKERS'))
    assert data['node'] == 'v24.20.0' and data['workers'] == '2'
    assert data['source'] == SOURCE
    write('runtime.json', data)
elif mode == 'finish':
    trace = OUTPUT / 'trace.jsonl'
    reasons = []
    rows = []
    if trace.exists():
        try:
            rows = [json.loads(line) for line in trace.read_text().splitlines()]
        except (ValueError, UnicodeError):
            reasons.append('malformed-trace')
    else:
        reasons.append('missing-trace')
    if Path(str(trace) + '.incomplete').exists() or any(r.get('event') == 'incomplete' for r in rows):
        reasons.append('capped-trace')
    shard_log = Path(os.environ['RUNNER_TEMP']) / 'pr144318-diagnostic-shard.log'
    if not shard_log.is_file():
        reasons.append('missing-shard-log')
    elif '[crabbox-witness-unavailable]' in shard_log.read_text(errors='replace'):
        reasons.append('witness-unavailable')
    phases = sorted({r.get('phase') for r in rows if r.get('phase')})
    if not any(r.get('event') == 'spawn-ready' and r.get('child') for r in rows):
        reasons.append('missing-outer-spawn')
    if not any(r.get('event') == 'process-start' for r in rows):
        reasons.append('missing-child-start')
    exit_file = OUTPUT / 'shard-exit.txt'
    exit_code = exit_file.read_text().strip() if exit_file.exists() else None
    if exit_code is None:
        reasons.append('missing-shard-exit')
    expected_phases = [
        '01-prepare-bound', '02-recover-bound-claim', '03-automatic-hold',
        '04-recover-released', '05-prepare-namespace', '06-recover-wrong-namespace',
        '07-recover-correct-namespace',
    ]
    if phases != expected_phases:
        reasons.append('incomplete-phase-coverage')
    # Be conservative on a failing run: startup events alone are not terminal
    # evidence. Partial traces remain useful for investigation, never complete.
    for phase in phases:
        outer = [r for r in rows if r.get('phase') == phase
                 and r.get('event') == 'spawn-begin' and r.get('evalSha256')]
        if not outer:
            reasons.append('missing-outer-begin:' + phase)
        for start in outer:
            events = [r for r in rows if r.get('phase') == phase
                      and r.get('pid') == start.get('pid') and r.get('id') == start.get('id')]
            ready = next((r for r in events if r.get('event') == 'spawn-ready' and r.get('child')), None)
            child = ready.get('child') if ready else None
            required = {'child-exit', 'child-close'}
            observed = {r.get('event') for r in events if r.get('child') == child}
            pipes = {r.get('stream') for r in events if r.get('event') == 'pipe-end' and r.get('child') == child}
            child_started = any(r.get('event') == 'process-start' and r.get('pid') == child
                                and r.get('phase') == phase for r in rows)
            if not child or not child_started or not required <= observed or pipes != {'stdout', 'stderr'}:
                reasons.append('nonterminal-outer-command:' + phase)
    write('completeness.json', {
        'complete': not reasons, 'reasons': reasons, 'phases': phases,
        'traceBytes': trace.stat().st_size if trace.exists() else 0,
        'traceSha256': digest(trace) if trace.exists() else None,
        'events': len(rows), 'shardExit': exit_code,
        'stepOutcome': os.environ.get('DIAGNOSTIC_OUTCOME'),
        'overlayFixtureSha256': digest(FIXTURE) if FIXTURE.exists() else None,
        'acceptance': False, 'causeResolved': False,
    })
    if reasons:
        raise SystemExit(1)
else:
    raise ValueError(mode)
