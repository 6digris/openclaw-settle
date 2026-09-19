"""Transport the retained PR147054 tarball without building, repacking, or executing it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

REPO = 'openclaw/openclaw'
CANDIDATE = '0aba608fe540de6650f070d4a46aef17cbef61fd'
COMPILED = '104710db892c724c0b07fffd263dbcbe578684bc'
NAME = 'openclaw-pr147054-0aba608f.tgz'
SHA = 'f2b2c7c81cc0c5d9273bbd22615ced4f244330d646c51ba407d7c22b646f078e'
SIZE = 74557440
TAG = 'pr147054-retained-f2b2c7c81cc0c5d9'
TITLE = 'Temporary PR147054 retained-package transport (not a release)'
BODY = 'Task-owned transport only; keep draft. Exact retained package, no rebuild. Remove after verified Actions transport. Candidate ' + CANDIDATE + '; compiled CI merge snapshot ' + COMPILED + ' (not pure-head output).'


def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def api(path, *, body=None):
    command = ['gh', 'api', '--hostname', 'github.com', 'repos/' + REPO + '/' + path]
    if body is not None:
        command += ['--method', 'POST', '--input', '-']
    result = subprocess.run(command, input=json.dumps(body) if body is not None else None,
                            text=True, capture_output=True, timeout=60)
    require(result.returncode == 0, 'GitHub API request failed for ' + path)
    return json.loads(result.stdout)


def binding(value):
    require(isinstance(value, dict) and set(value) == {'releaseId', 'assetId'}, 'Expected releaseId and assetId only')
    require(all(type(v) is int and v > 0 for v in value.values()), 'IDs must be positive integers')
    return value


def validate_release(release, release_id):
    require(release.get('id') == release_id and release.get('draft') is True,
            'Transport release must be the exact draft')
    require(release.get('tag_name') == TAG and release.get('target_commitish') == CANDIDATE,
            'Transport release target/tag mismatch')
    require(release.get('name') == TITLE and release.get('body') == BODY,
            'Transport release is not task-owned')


def validate_asset(asset, asset_id):
    require(asset.get('id') == asset_id and asset.get('state') == 'uploaded', 'Asset ID/state mismatch')
    require(asset.get('name') == NAME and asset.get('size') == SIZE, 'Asset name/size mismatch')
    require(asset.get('digest') == 'sha256:' + SHA, 'Asset digest mismatch')


def validate_pair(release, asset, selected):
    binding(selected)
    validate_release(release, selected['releaseId'])
    validate_asset(asset, selected['assetId'])
    members = release.get('assets', [])
    require(len(members) == 1 and members[0].get('id') == selected['assetId'],
            'Draft must contain only this exact asset')
    validate_asset(members[0], selected['assetId'])


def verify_tarball(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size == SIZE, 'Tarball size/type mismatch')
    require(digest(path) == SHA, 'Tarball SHA mismatch')


def stage(package, receipt):
    require(package.name == NAME, 'Retained package filename mismatch')
    verify_tarball(package)  # Reject before any remote mutation.
    # Paginate drafts as tag lookup is not guaranteed to expose unpublished releases.
    result = subprocess.run(['gh', 'api', '--hostname', 'github.com', '--paginate', '--slurp',
                             'repos/' + REPO + '/releases?per_page=100'],
                            text=True, capture_output=True, timeout=120)
    require(result.returncode == 0, 'Cannot inventory draft transport releases')
    matches = [item for page in json.loads(result.stdout) for item in page if item.get('tag_name') == TAG]
    require(len(matches) <= 1, 'Ambiguous transport draft; do not duplicate')
    if matches:
        release = matches[0]
        validate_release(release, release['id'])
    else:
        release = api('releases', body={'tag_name': TAG, 'target_commitish': CANDIDATE,
                                       'name': TITLE, 'body': BODY, 'draft': True, 'prerelease': True,
                                       'generate_release_notes': False})
    validate_release(release, release['id'])
    receipt['releaseId'] = release['id']  # Retain cleanup identity even if upload fails.
    receipt['draftTag'] = TAG
    require(len(release.get('assets', [])) <= 1, 'Foreign assets in owned draft')
    if not release.get('assets'):
        # No --clobber; an existing asset is never overwritten.
        result = subprocess.run(['gh', 'release', 'upload', TAG, str(package), '--repo', REPO],
                                text=True, capture_output=True, timeout=240)
        require(result.returncode == 0, 'Draft asset upload failed; inspect retained releaseId before retry')
        release = api('releases/' + str(release['id']))
    require(len(release.get('assets', [])) == 1, 'Expected one retained package asset')
    selected = {'releaseId': release['id'], 'assetId': release['assets'][0]['id']}
    asset = api('releases/assets/' + str(selected['assetId']))
    validate_pair(release, asset, selected)
    verify_tarball(package)
    receipt.update(binding=selected, asset=asset, release=release)


def fetch(root, selected, receipt):
    binding(selected)
    release = api('releases/' + str(selected['releaseId']))
    asset = api('releases/assets/' + str(selected['assetId']))
    validate_pair(release, asset, selected)
    receipt.update(binding=selected, asset=asset, release=release)
    free = shutil.disk_usage(root).free
    require(free >= 3 * SIZE, 'Insufficient transport destination capacity')
    receipt['downloadCapacity'] = {'path': str(root), 'freeBytes': free, 'additionalBytes': 3 * SIZE,
                                   'concurrentJobsOnVM': 0}
    package_dir = root / 'package'
    package_dir.mkdir()  # Refuse stale/reused destination.
    package = package_dir / NAME
    partial = root / (NAME + '.partial')
    try:
        with partial.open('xb') as stream:
            result = subprocess.run(['gh', 'api', '--hostname', 'github.com',
                                     '-H', 'Accept: application/octet-stream',
                                     'repos/' + REPO + '/releases/assets/' + str(selected['assetId'])],
                                    stdout=stream, stderr=subprocess.PIPE, timeout=180)
        require(result.returncode == 0, 'Release asset download failed')
        verify_tarball(partial)
        partial.replace(package)
    finally:
        partial.unlink(missing_ok=True)
    receipt['tarball'] = {'path': str(package), 'bytes': SIZE, 'sha256': digest(package)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['stage', 'fetch'])
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--package', type=Path)
    args = parser.parse_args()
    args.root.mkdir(parents=True, exist_ok=False)
    receipt = {'status': 'FAIL', 'candidate': CANDIDATE, 'compiledCommit': COMPILED,
               'compiledScope': 'CI merge snapshot, not pure candidate compiler output',
               'tarballSha256': SHA, 'tarballBytes': SIZE, 'mode': args.mode,
               'scriptSha256': digest(Path(__file__)), 'startedAt': datetime.now(timezone.utc).isoformat()}
    code = 1
    try:
        if args.mode == 'stage':
            require(args.package is not None, 'Retained package path required')
            stage(args.package, receipt)
        else:
            require(os.environ.get('GITHUB_REPOSITORY') == REPO, 'Wrong repository')
            workflow_sha = os.environ.get('GITHUB_WORKFLOW_SHA', '')
            require(re.fullmatch('[0-9a-f]{40}', workflow_sha), 'Exact workflow SHA required')
            tooling = Path(__file__).resolve().parents[3]
            head = subprocess.check_output(['git', '-C', str(tooling), 'rev-parse', 'HEAD'], text=True).strip()
            require(head == workflow_sha, 'Tooling/workflow identity mismatch')
            require(not subprocess.check_output(['git', '-C', str(tooling), 'status', '--porcelain'], text=True).strip(), 'Dirty tooling')
            receipt['producer'] = {'workflowSha': workflow_sha, 'runId': os.environ['GITHUB_RUN_ID'],
                                   'runAttempt': os.environ['GITHUB_RUN_ATTEMPT']}
            fetch(args.root, json.loads(os.environ['TRANSPORT_BINDING']), receipt)
        receipt['status'] = 'PASS'
        code = 0
    except Exception as error:
        receipt['error'] = type(error).__name__ + ': ' + str(error)
    finally:
        receipt['completedAt'] = datetime.now(timezone.utc).isoformat()
        (args.root / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'status': receipt['status'], 'receipt': str(args.root / 'receipt.json')}))
    return code


if __name__ == '__main__':
    sys.exit(main())
