"""Own one fresh canonical profile alias; never relocate or remove account data."""
import json
import os
import re
import subprocess
from pathlib import Path
from identity import require, save
import windows_native as native


def lexists(path):
    try:
        Path(path).lstat()
        return True
    except FileNotFoundError:
        return False


def binding(root, owner, home):
    root, home = Path(root).resolve(), Path(home).resolve()
    profile = owner['profiles']['scheduled-task']
    require(re.fullmatch(r'pr147054-scheduled-task-[0-9a-f]{12}', profile),
            'Not a task-specific lowercase profile')
    require(home.is_dir(), 'Account home missing')
    target = root / 'scheduled-task/state'
    require(target.is_dir() and not target.is_symlink() and
            target.resolve() == target and not target.is_junction(), 'Profile target is not owned state')
    return {'home': str(home), 'profile': profile,
            'path': str(home / ('.openclaw-' + profile)), 'target': str(target)}


def claim(root, owner, node, env):
    # Query the same real OS account home used by the unchanged service guard.
    home = Path(json.loads(subprocess.check_output(
        [node, '--input-type=module', '-e',
         "import os from 'node:os'; console.log(JSON.stringify(os.userInfo().homedir));"],
        text=True, env=env, timeout=30))).resolve()
    require(home == Path(os.environ['USERPROFILE']).resolve(), 'OS account home disagreement')
    item = binding(root, owner, home)
    link = Path(item['path'])
    require(not lexists(link), 'Canonical profile already exists; never adopt it')
    # Persist cleanup intent before allocation, including interruption during New-Item.
    owner['canonicalProfile'] = item
    save(Path(root) / 'OWNER.json', owner)
    native.powershell("$ErrorActionPreference='Stop'; "
                      "New-Item -ItemType Junction -Path $env:PR147054_ARG_0 "
                      "-Target $env:PR147054_ARG_1 | Out-Null", item['path'], item['target'])
    require(link.is_junction() and link.resolve() == Path(item['target']),
            'Canonical profile junction target mismatch')
    # Keep explicit state/config under the owned root. The actual service guard
    # compares their real filesystem identity to this canonical named profile.
    env.update(HOME=str(home), USERPROFILE=str(home))
    return item


def retire(root, owner):
    item = owner.get('canonicalProfile')
    if item is None:
        return {'claimed': False}
    expected = binding(root, owner, Path(os.environ['USERPROFILE']))
    require(item == expected, 'Canonical profile ownership binding changed')
    link = Path(item['path'])
    if lexists(link):
        require(link.is_symlink() or link.is_junction(), 'Canonical profile is not an owned alias')
        require(link.resolve() == Path(item['target']), 'Canonical profile target changed')
        # Non-recursive removal of the link only; target bytes stay in the proof root.
        if link.is_symlink():
            link.unlink()
        else:
            link.rmdir()
    require(not lexists(link), 'Canonical profile alias survived cleanup')
    return {'claimed': True, 'path': str(link), 'aliasAbsent': True,
            'targetPreserved': Path(item['target']).is_dir()}
