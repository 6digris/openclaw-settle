"""V2 identity checks; raw lifecycle gaps remain visible, never acceptance."""
def valid_pipe_state(pipes):
    if not isinstance(pipes, dict) or set(pipes) != {'stdout', 'stderr'}:
        return False
    return all(isinstance(pipe, dict) and type(pipe.get('present')) is bool
               and (not pipe['present'] or all(type(pipe.get(k)) is bool
                    for k in ['ended', 'destroyed', 'closed'])) for pipe in pipes.values())


def validate(rows):
    reasons = []
    starts = {}
    groups = {}
    sequences = set()
    observers = set()
    valid_rows = []
    command_events = {
        'spawn-begin', 'spawn-ready', 'spawn-throw', 'child-error', 'child-exit',
        'child-close', 'pipe-end', 'spawnSync-begin', 'spawnSync-end', 'spawnSync-throw',
        'execFileSync-begin', 'execFileSync-end', 'execFileSync-throw',
        'timeout-snapshot', 'cancellation-requested',
    }
    process_events = {'observer-init', 'process-start', 'before-exit', 'process-exit', 'alive'}
    for row in rows:
        if not isinstance(row, dict):
            reasons.append('malformed-event')
            continue
        if row.get('event') == 'incomplete':
            reasons.append('witness-incomplete')
            continue
        actor = (row.get('pid'), row.get('threadId'), row.get('observer'))
        seq = row.get('sequence')
        parent = row.get('parentCommand')
        if 'parentCommand' not in row:
            reasons.append('missing-parent-command')
        if (row.get('version') != 2 or type(actor[0]) is not int or actor[0] <= 0
                or type(row.get('ppid')) is not int or row['ppid'] <= 0
                or type(actor[1]) is not int or actor[1] < 0
                or not isinstance(actor[2], str) or not actor[2]
                or type(seq) is not int or seq <= 0
                or not isinstance(row.get('phase'), str) or not row['phase']
                or (parent is not None and (not isinstance(parent, str) or not parent))
                or not isinstance(row.get('event'), str)
                or row['event'] not in command_events | process_events):
            reasons.append('missing-v2-identity')
            continue
        if row['event'] in command_events and (
                not isinstance(row.get('command'), str) or not row['command']
                or type(row.get('id')) is not int or row['id'] <= 0):
            reasons.append('missing-command-identity')
            continue
        if row['event'] in process_events and row.get('command') is not None:
            reasons.append('unexpected-command-identity')
            continue
        valid_rows.append(row)
        if (*actor, seq) in sequences:
            reasons.append('duplicate-observer-sequence')
        sequences.add((*actor, seq))
        if row.get('event') == 'observer-init':
            observers.add(actor)
        command = row.get('command')
        if command:
            expected = ':'.join(str(x) for x in (*actor, row.get('id')))
            if command != expected:
                reasons.append('mismatched-command-identity')
            groups.setdefault(command, []).append(row)
            if row.get('event') in ('spawn-begin', 'spawnSync-begin', 'execFileSync-begin'):
                if command in starts:
                    reasons.append('duplicate-command-begin')
                starts[command] = row
    for command, events in groups.items():
        start = starts.get(command)
        if not start:
            reasons.append('terminal-without-begin')
            continue
        actor = (start['pid'], start['threadId'], start['observer'])
        if actor not in observers:
            reasons.append('missing-observer-init')
        if any((r.get('pid'), r.get('threadId'), r.get('observer')) != actor
               or r.get('phase') != start.get('phase')
               or r.get('parentCommand') != start.get('parentCommand') for r in events):
            reasons.append('cross-context-command')
        if any(r is not start and r.get('sequence', 0) <= start['sequence'] for r in events):
            reasons.append('terminal-before-begin')
        kind = start['event'].removesuffix('-begin')
        terminal = [r for r in events if r['event'] in
                    (('spawn-throw', 'child-close') if kind == 'spawn'
                     else (kind + '-end', kind + '-throw'))]
        if len(terminal) != 1:
            reasons.append('missing-or-duplicate-terminal')
        if kind == 'spawn' and not any(r['event'] == 'spawn-throw' for r in terminal):
            ready = [r for r in events if r['event'] == 'spawn-ready']
            if len(ready) != 1:
                reasons.append('missing-or-duplicate-spawn-ready')
                continue
            child = ready[0].get('child')
            if not valid_pipe_state(ready[0].get('pipes')):
                reasons.append('missing-spawn-pipe-state')
            child_events = [r for r in events if r['event'] in ('child-exit', 'child-close', 'pipe-end')]
            if any(r.get('child') != child for r in child_events):
                reasons.append('mismatched-child')
            if child and not any(r['event'] == 'child-exit' for r in child_events):
                reasons.append('missing-child-exit')
            expected_pipes = {name for name, state in ready[0]['pipes'].items() if state['present']} if valid_pipe_state(ready[0].get('pipes')) else set()
            observed_pipes = {r.get('stream') for r in child_events if r['event'] == 'pipe-end'}
            if not expected_pipes <= observed_pipes:
                reasons.append('missing-pipe-end')
        snapshots = [r for r in events if r['event'] == 'timeout-snapshot']
        for snap in snapshots:
            leader = snap.get('leader')
            pipes = snap.get('pipes')
            active = snap.get('active')
            valid_leader = (isinstance(leader, dict)
                            and set(leader) == {'exitCode', 'signalCode', 'killed'}
                            and (leader['exitCode'] is None or type(leader['exitCode']) is int)
                            and (leader['signalCode'] is None or isinstance(leader['signalCode'], str))
                            and type(leader['killed']) is bool)
            valid_pipes = valid_pipe_state(pipes)
            valid_active = isinstance(active, list) and 0 < len(active) <= 32
            if valid_active:
                refs = [r.get('command') for r in active if isinstance(r, dict)]
                valid_active = (len(refs) == len(active) and all(isinstance(ref, str) for ref in refs)
                                and len(set(refs)) == len(refs) and command in refs)
                for item in active:
                    begin = starts.get(item.get('command')) if isinstance(item, dict) and isinstance(item.get('command'), str) else None
                    valid_active = valid_active and bool(begin) and all(
                        begin.get(k) == item.get(k) for k in ['id', 'phase', 'kind']) and all(
                        begin.get(k) == snap.get(k) for k in ['pid', 'threadId', 'observer'])
            ready_children = [r.get('child') for r in events if r['event'] == 'spawn-ready']
            if (kind != 'spawn' or ready_children != [snap.get('child')]
                    or snap.get('scope') != 'current-observer'
                    or type(snap.get('timeoutMs')) is not int or snap['timeoutMs'] <= 0
                    or not valid_leader or not valid_pipes or not valid_active
                    or snap.get('activeTruncated') is not False):
                reasons.append('malformed-timeout-snapshot')
            paired = [r for r in events if r['event'] == 'cancellation-requested'
                      and r.get('snapshotSequence') == snap['sequence']
                      and r['sequence'] > snap['sequence'] and r.get('child') == snap.get('child')]
            if len(paired) != 1 or snap.get('boundary') != 'before-cancellation':
                reasons.append('unpaired-timeout-snapshot')
            if snap.get('activeTruncated'):
                reasons.append('truncated-timeout-state')
        if any(r['event'] == 'cancellation-requested' and not any(
                s['sequence'] == r.get('snapshotSequence') for s in snapshots) for r in events):
            reasons.append('cancellation-without-snapshot')
    traced_pids = {r.get('pid') for r in valid_rows if type(r.get('pid')) is int}
    traced_children = {r.get('child') for r in valid_rows
                       if r.get('event') in ('spawn-ready', 'spawnSync-end', 'child-exit', 'child-close')
                       and type(r.get('child')) is int}
    for row in valid_rows:
        parent = row.get('parentCommand')
        # Main/loader threads share a PID. The process parent or an observed
        # spawning command establishes that this is not an independent root;
        # the latter still holds after orphan reparenting changes PPID.
        if (row.get('event') != 'incomplete' and not parent
                and (row.get('ppid') in traced_pids or row.get('pid') in traced_children)):
            reasons.append('missing-parent-command')
        if parent and parent not in starts:
            reasons.append('missing-parent-command')
        if row.get('event') == 'process-start' and parent:
            ready = [r for r in groups.get(parent, []) if r['event'] == 'spawn-ready']
            # Synchronous Node children link to their parent command too; spawnSync
            # reports its PID on the terminal, while execFileSync returns only bytes.
            reported = [r.get('child') for r in groups.get(parent, []) if r.get('child')]
            if reported and row.get('pid') not in reported:
                reasons.append('mismatched-process-parent')
    if not starts:
        reasons.append('missing-v2-command')
    return sorted(set(reasons))
