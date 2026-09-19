"""Fresh Windows production install of the retained tarball; no source build."""
import argparse
import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from datetime import datetime, timezone
from identity import digest, require, save, snapshot, verify_archive

DRIVER = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    require(sys.platform == 'win32' and sys.dont_write_bytecode, 'Windows and python -B required')
    require(not root.exists(), 'Never overwrite/replay an existing installation')
    require(os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'Fresh GitHub-hosted Windows VM required')
    # Whole operation: tar copy75MB, installed closure~650MB on macOS, Windows native
    # optional packages/cache up to3GB, fixture/log/review<1GB, transient install~1GB.
    # Re-measure on actual work destination. No coordinator-local bytes count here.
    root.parent.mkdir(parents=True, exist_ok=True)
    required = 6 * 1024**3
    free = shutil.disk_usage(root.parent).free
    require(free > required, 'Destination cannot fit the 6 GiB whole-operation growth estimate')
    root.mkdir()
    owner = {'pr': 147054, 'root': str(root), 'tasks': [], 'ports': [], 'sealSha256': '',
             'profiles': {mode: 'pr147054-' + mode + '-' + uuid.uuid4().hex[:12]
                          for mode in ('ctrl-c', 'ctrl-break', 'scheduled-task')}}
    save(root / 'OWNER.json', owner)
    save(root / 'CAPACITY.json', {'destination': str(root), 'freeBytes': free,
         'remainingGrowthBytes': required, 'concurrentHostedOperations': 0,
         'basis': 'Dedicated fresh job; no build; one installed production closure and npm cache; three sequential cells'})
    result = {'state': 'VALIDATING', 'startedAt': datetime.now(timezone.utc).isoformat(), 'archive': str(args.archive.resolve()),
              'candidate': str(args.candidate.resolve()), 'root': str(root)}
    try:
        spec = json.loads((DRIVER / 'spec.json').read_text(encoding='utf-8'))
        result['expectedPackageSha256'] = spec['packageSha256']
        result['actualPackageSha256'] = digest(args.archive)
        require(result['actualPackageSha256'] == result['expectedPackageSha256'], 'Wrong transported package')
        head = subprocess.check_output(['git', '-C', str(args.candidate), 'rev-parse', 'HEAD'], text=True).strip()
        result['expectedCandidateHead'] = spec['candidateHead']
        result['actualCandidateHead'] = head
        require(head == spec['candidateHead'], 'Wrong candidate checkout')
        result['candidateSourceBindings'] = {}
        for path, expected in spec['candidateSource'].items():
            actual = digest(args.candidate / path)
            result['candidateSourceBindings'][path] = {'expected': expected, 'actual': actual}
            require(actual == expected, 'Candidate source bytes changed: ' + path)
        result['fixtureBindings'] = {}
        for path, expected in spec['fixtureSource'].items():
            actual = digest(DRIVER / 'fixture-source' / path)
            result['fixtureBindings'][path] = {'expected': expected, 'actual': actual}
            require(actual == expected, 'Mock fixture changed: ' + path)
        shutil.copyfile(args.archive, root / 'candidate.tgz')
        node = Path(shutil.which('node')).resolve()
        # Execute npm's JS entry directly, not a shell command requiring quote expansion.
        npm = Path(shutil.which('npm.cmd')).parent / 'node_modules/npm/bin/npm-cli.js'
        require(npm.is_file(), 'Cannot resolve installed npm CLI')
        env = {key: value for key, value in os.environ.items()
               if key.casefold() in {'path','pathext','systemroot','windir','comspec','programdata','programfiles','programfiles(x86)','systemdrive'}}
        for name in ('home','appdata','localappdata','tmp'):
            (root / name).mkdir()
        env.update(HOME=str(root / 'home'), USERPROFILE=str(root / 'home'), APPDATA=str(root / 'appdata'),
                   LOCALAPPDATA=str(root / 'localappdata'), TEMP=str(root / 'tmp'), TMP=str(root / 'tmp'),
                   NODE_COMPILE_CACHE=str(root / 'compile-cache'), PYTHONDONTWRITEBYTECODE='1')
        command = [str(node), str(npm), 'install', '--prefix', str(root / 'runtime'), '--omit=dev',
                   '--no-audit', '--no-fund', '--cache', str(root / 'npm-cache'), str(root / 'candidate.tgz')]
        result.update(command=command, packageSha256=spec['packageSha256'], candidateHead=head, state='INSTALLING')
        with (root / 'install.log').open('w', encoding='utf-8') as log:
            p = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=900)
        result['exitCode'] = p.returncode
        require(p.returncode == 0, 'Production install failed; retained log')
        result['package'] = verify_archive(root / 'candidate.tgz', root / 'runtime/node_modules/openclaw', spec)
        seal = {'root': str(root), 'runtime': snapshot(root / 'runtime'), 'driver': snapshot(DRIVER),
                'node': str(node), 'nodeSha256': digest(node), 'python': sys.executable,
                'pythonSha256': digest(sys.executable), 'npmSha256': digest(npm),
                'packageSha256': digest(root / 'candidate.tgz'), 'candidateHead': head,
                'compiledCommit': spec['compiledCommit']}
        save(root / 'execution-seal.json', seal)
        owner['sealSha256'] = digest(root / 'execution-seal.json')
        save(root / 'OWNER.json', owner)
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as out:
                out.write('seal=' + owner['sealSha256'] + '\n')
        result['state'] = 'SEALED'
        print(json.dumps({'seal': owner['sealSha256'], 'root': str(root)}))
    except BaseException as exc:
        result['state'] = 'FAIL'
        result['error'] = type(exc).__name__ + ': ' + str(exc)
        raise
    finally:
        result['completedAt'] = datetime.now(timezone.utc).isoformat()
        save(root / 'INSTALL.json', result)


if __name__ == '__main__':
    main()
