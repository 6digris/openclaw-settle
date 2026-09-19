"""Archive, installed closure, tool, source and driver binding for the Windows cell."""
import hashlib
import json
import os
import tarfile
from pathlib import Path, PurePosixPath


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def save(path, data):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
    os.replace(tmp, path)


def snapshot(root):
    root = Path(root).resolve()
    rows = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(directory) / name
            rel = path.relative_to(root).as_posix()
            require(path.resolve().is_relative_to(root), 'Closure path escapes root: ' + rel)
            if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
                rows[rel] = {'link': os.readlink(path)}
            elif path.is_file():
                rows[rel] = {'sha256': digest(path)}
    return rows


def verify_archive(archive, package, spec):
    require(digest(archive) == spec['packageSha256'], 'Wrong package archive digest')
    package = Path(package).resolve()
    build = json.loads((package / 'dist/build-info.json').read_text(encoding='utf-8'))
    require(build == spec['buildInfo'], 'Wrong installed build identity')
    count = 0
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar:
            parts = PurePosixPath(member.name).parts
            require(parts and parts[0] == 'package' and '..' not in parts,
                    'Invalid archive member path')
            relative = Path(*parts[1:])
            installed = package / relative
            require(installed.resolve().is_relative_to(package), 'Package path escape')
            if member.isdir():
                continue
            if relative.as_posix() == '.openclaw-lifecycle-pending':
                require(not installed.exists(), 'Install lifecycle still pending')
                continue
            if member.isfile():
                require(installed.is_file() and not installed.is_symlink(),
                        'Missing package member: ' + str(relative))
                with tar.extractfile(member) as stream:
                    expected = hashlib.file_digest(stream, 'sha256').hexdigest()
                require(digest(installed) == expected, 'Changed package member: ' + str(relative))
            elif member.issym():
                require(installed.is_symlink() and os.readlink(installed) == member.linkname,
                        'Changed package symlink')
            else:
                raise RuntimeError('Unsupported archive member')
            count += 1
    require((package / 'openclaw.mjs').is_file(), 'Missing launcher')
    return {'verifiedMembers': count, 'buildInfo': build,
            'packageSha256': digest(archive), 'candidateHead': spec['candidateHead'],
            'compiledCommit': build['commit'], 'scope': spec['scope']}


def verify_seal(root, driver, expected_seal):
    root, driver = Path(root).resolve(), Path(driver).resolve()
    seal_path = root / 'execution-seal.json'
    require(digest(seal_path) == expected_seal, 'Execution seal changed')
    seal = json.loads(seal_path.read_text(encoding='utf-8'))
    require(str(root) == seal['root'], 'Alternate installation root rejected')
    require(snapshot(root / 'runtime') == seal['runtime'], 'Installed dependency closure changed')
    require(snapshot(driver) == seal['driver'], 'Proof driver or fixture bytes changed')
    require(digest(seal['node']) == seal['nodeSha256'], 'Node executable changed')
    require(digest(seal['python']) == seal['pythonSha256'], 'Python executable changed')
    require(digest(root / 'candidate.tgz') == seal['packageSha256'], 'Package input changed')
    return seal
