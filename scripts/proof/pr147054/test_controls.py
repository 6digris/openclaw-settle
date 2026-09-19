"""Portable negative controls; not native Windows acceptance."""
import io
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import identity
import prove
import prepare
import profile_home
import os


class ProofControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'owned'; self.root.mkdir()
        self.driver = self.base / 'driver'; self.driver.mkdir()
        self.package = self.root / 'runtime/node_modules/openclaw'
        (self.package / 'dist').mkdir(parents=True)
        self.build = {'commit': 'a' * 40, 'version': 'fixture'}
        files = {'openclaw.mjs': b'// fixture, never executed',
                 'dist/build-info.json': json.dumps(self.build).encode()}
        self.archive = self.root / 'candidate.tgz'
        with tarfile.open(self.archive, 'w:gz') as tar:
            for name, data in files.items():
                info = tarfile.TarInfo('package/' + name); info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
                (self.package / name).write_bytes(data)
        self.spec = {'packageSha256': identity.digest(self.archive), 'candidateHead': 'b' * 40,
                     'buildInfo': self.build, 'scope': 'synthetic negative control'}
        identity.save(self.driver / 'spec.json', self.spec)
        self.seal = {'root': str(self.root), 'runtime': identity.snapshot(self.root / 'runtime'),
                     'driver': identity.snapshot(self.driver), 'node': sys.executable,
                     'nodeSha256': identity.digest(sys.executable), 'python': sys.executable,
                     'pythonSha256': identity.digest(sys.executable),
                     'packageSha256': identity.digest(self.archive)}
        identity.save(self.root / 'execution-seal.json', self.seal)
        self.sha = identity.digest(self.root / 'execution-seal.json')
        identity.save(self.root / 'OWNER.json', {'pr': 147054, 'root': str(self.root),
                      'sealSha256': self.sha, 'tasks': [], 'ports': []})

    def test_rejects_wrong_archive(self):
        with self.archive.open('ab') as f:
            f.write(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'Wrong package archive'):
            identity.verify_archive(self.archive, self.package, self.spec)

    def test_rejects_wrong_build_even_with_valid_archive(self):
        identity.save(self.package / 'dist/build-info.json', {'commit': 'c' * 40})
        with self.assertRaisesRegex(RuntimeError, 'build identity'):
            identity.verify_archive(self.archive, self.package, self.spec)

    def test_rejects_dependency_closure_change(self):
        identity.verify_seal(self.root, self.driver, self.sha)
        (self.root / 'runtime/injected.js').write_text('changed')
        with self.assertRaisesRegex(RuntimeError, 'dependency closure'):
            identity.verify_seal(self.root, self.driver, self.sha)

    def test_rejects_alternate_root_with_same_package(self):
        alternate = self.base / 'alternate'
        shutil.copytree(self.root, alternate)
        with self.assertRaisesRegex(RuntimeError, 'Alternate installation'):
            identity.verify_seal(alternate, self.driver, self.sha)

    def test_correlates_provider_admission(self):
        log = self.base / 'requests.jsonl'
        row = {'seq': 3, 'method': 'POST', 'path': '/v1/responses',
               'body': {'model': prove.MODEL, 'input': 'unique-proof-request'}}
        for field, value in [('path', '/other'), ('method', 'GET')]:
            wrong = dict(row); wrong[field] = value
            log.write_text(json.dumps(wrong) + '\n')
            self.assertIsNone(prove.admission(log, 'unique-proof-request'))
        log.write_text(json.dumps(row) + '\n')
        self.assertIsNone(prove.admission(log, 'other-proof-request'))
        self.assertEqual(prove.admission(log, 'unique-proof-request')['seq'], 3)

    def test_wrong_package_finalizes_receipt_without_native_allocation(self):
        self.spec['packageSha256'] = '0' * 64
        identity.save(self.driver / 'spec.json', self.spec)
        self.seal['driver'] = identity.snapshot(self.driver)
        identity.save(self.root / 'execution-seal.json', self.seal)
        self.sha = identity.digest(self.root / 'execution-seal.json')
        owner = json.loads((self.root / 'OWNER.json').read_text()); owner['sealSha256'] = self.sha
        identity.save(self.root / 'OWNER.json', owner)
        argv = ['prove.py', '--root', str(self.root), '--seal', self.sha]
        with patch.object(prove, 'DRIVER', self.driver), patch.object(sys, 'platform', 'win32'), \
             patch.object(sys, 'argv', argv), patch.object(prove, 'run_cell') as native:
            self.assertEqual(prove.main(), 1)
            native.assert_not_called()
        receipt = json.loads((self.root / 'RESULT.json').read_text())
        self.assertEqual(receipt['state'], 'FAIL')
        self.assertIn('Wrong package archive', receipt['error'])
        self.assertTrue(receipt['completedAt'])

    def test_prepare_wrong_tarball_records_rejection_before_npm(self):
        target = self.base / 'prepare-owned'
        self.spec['packageSha256'] = '0' * 64
        identity.save(self.driver / 'spec.json', self.spec)
        argv = ['prepare.py', '--root', str(target), '--archive', str(self.archive),
                '--candidate', str(self.base / 'unused-candidate')]
        with patch.object(prepare, 'DRIVER', self.driver), patch.object(sys, 'platform', 'win32'), \
             patch.object(sys, 'argv', argv), patch.dict(prepare.os.environ, {'RUNNER_ENVIRONMENT': 'github-hosted'}), \
             patch.object(prepare.subprocess, 'run') as npm:
            with self.assertRaisesRegex(RuntimeError, 'Wrong transported package'):
                prepare.main()
            npm.assert_not_called()
        receipt = json.loads((target / 'INSTALL.json').read_text())
        self.assertEqual(receipt['state'], 'FAIL')
        self.assertEqual(receipt['expectedPackageSha256'], '0' * 64)
        self.assertEqual(receipt['actualPackageSha256'], identity.digest(self.archive))
        owner = json.loads((target / 'OWNER.json').read_text())
        self.assertEqual(owner['tasks'], [])
        self.assertFalse((target / 'runtime').exists())

    def test_cleanup_attempts_later_phases_after_task_error(self):
        row = {}
        owner = {'tasks': ['fixture'], 'ports': []}
        with patch.object(prove.native, 'remove_task', side_effect=RuntimeError('fixture refusal')), \
             patch.object(prove.native, 'owned', return_value={}) as processes, \
             patch.object(prove.native, 'task_xml', return_value='still registered'):
            self.assertFalse(prove.cleanup(self.root, owner, row))
            self.assertEqual(processes.call_count, 2)
        self.assertTrue(row['cleanup']['errors'])

    def profile_fixture(self):
        home = self.base / 'account'; home.mkdir()
        state = self.root / 'scheduled-task/state'; state.mkdir(parents=True)
        owner = {'profiles': {'scheduled-task': 'pr147054-scheduled-task-012345abcdef'}}
        item = profile_home.binding(self.root, owner, home)
        owner['canonicalProfile'] = item
        return home, state, owner, Path(item['path'])

    def test_profile_alias_cleanup_preserves_target_and_account_data(self):
        home, state, owner, link = self.profile_fixture()
        (home / 'unrelated.txt').write_text('keep'); (state / 'openclaw.json').write_text('{}')
        link.symlink_to(state, target_is_directory=True)
        with patch.dict(os.environ, {'USERPROFILE': str(home)}):
            self.assertTrue(profile_home.retire(self.root, owner)['aliasAbsent'])
            self.assertTrue(profile_home.retire(self.root, owner)['aliasAbsent'])
        self.assertFalse(profile_home.lexists(link))
        self.assertTrue((state / 'openclaw.json').is_file())
        self.assertEqual((home / 'unrelated.txt').read_text(), 'keep')

    def test_profile_cleanup_rejects_retargeted_alias(self):
        home, state, owner, link = self.profile_fixture()
        other = self.base / 'foreign'; other.mkdir(); link.symlink_to(other, target_is_directory=True)
        with patch.dict(os.environ, {'USERPROFILE': str(home)}):
            with self.assertRaisesRegex(RuntimeError, 'target changed'):
                profile_home.retire(self.root, owner)
        self.assertTrue(link.is_symlink()); self.assertTrue(other.is_dir())

    def test_profile_cleanup_rejects_real_directory_and_mutated_binding(self):
        home, state, owner, link = self.profile_fixture(); link.mkdir()
        with patch.dict(os.environ, {'USERPROFILE': str(home)}):
            with self.assertRaisesRegex(RuntimeError, 'not an owned alias'):
                profile_home.retire(self.root, owner)
            owner['canonicalProfile']['path'] = str(home)
            with self.assertRaisesRegex(RuntimeError, 'binding changed'):
                profile_home.retire(self.root, owner)
        self.assertTrue(link.is_dir()); self.assertTrue(home.is_dir())

    def test_existing_canonical_profile_cannot_be_adopted(self):
        home, state, owner, link = self.profile_fixture(); link.symlink_to(state, target_is_directory=True)
        owner.pop('canonicalProfile')
        with patch.dict(os.environ, {'USERPROFILE': str(home)}), \
             patch.object(profile_home.subprocess, 'check_output', return_value=json.dumps(str(home))), \
             patch.object(profile_home.native, 'powershell') as native:
            with self.assertRaisesRegex(RuntimeError, 'already exists'):
                profile_home.claim(self.root, owner, sys.executable, {})
            native.assert_not_called()
        self.assertNotIn('canonicalProfile', owner)

    def test_alias_preserved_when_native_cleanup_is_unverified(self):
        home, state, owner, link = self.profile_fixture(); link.symlink_to(state, target_is_directory=True)
        owner.update(tasks=[], ports=[])
        with patch.object(prove.native, 'owned', return_value={1: {'ProcessId': 1}}), \
             patch.object(prove.native, 'kill_owned', side_effect=RuntimeError('still live')), \
             patch.object(prove.profile_home, 'retire') as retire:
            self.assertFalse(prove.cleanup(self.root, owner, {}))
            retire.assert_not_called()
        self.assertTrue(link.is_symlink())

    def test_partial_alias_creation_keeps_cleanup_custody(self):
        home, state, owner, link = self.profile_fixture(); owner.pop('canonicalProfile')
        def interrupted(*args):
            link.symlink_to(state, target_is_directory=True)
            raise RuntimeError('interrupted after allocation')
        with patch.dict(os.environ, {'USERPROFILE': str(home)}), \
             patch.object(profile_home.subprocess, 'check_output', return_value=json.dumps(str(home))), \
             patch.object(profile_home.native, 'powershell', side_effect=interrupted):
            with self.assertRaisesRegex(RuntimeError, 'interrupted after allocation'):
                profile_home.claim(self.root, owner, sys.executable, {})
            self.assertEqual(json.loads((self.root / 'OWNER.json').read_text())['canonicalProfile'], owner['canonicalProfile'])
            self.assertTrue(profile_home.retire(self.root, owner)['aliasAbsent'])
        self.assertTrue(state.is_dir())

    def test_profile_binding_rejects_path_traversal(self):
        home, state, owner, link = self.profile_fixture()
        owner['profiles']['scheduled-task'] = '../default'
        with self.assertRaisesRegex(RuntimeError, 'task-specific'):
            profile_home.binding(self.root, owner, home)
        self.assertFalse(profile_home.lexists(link))

    def test_scheduled_only_selection_does_not_replay_console_cells(self):
        owner = json.loads((self.root / 'OWNER.json').read_text())
        argv = ['prove.py', '--root', str(self.root), '--seal', self.sha, '--case', 'scheduled-task']
        with patch.object(prove, 'DRIVER', self.driver), patch.object(sys, 'platform', 'win32'), \
             patch.object(sys, 'argv', argv), patch.object(prove, 'run_cell', return_value={'state':'PASS'}) as cell:
            self.assertEqual(prove.main(), 0)
            self.assertEqual(cell.call_count, 1)
            self.assertEqual(cell.call_args.args[2], 'scheduled-task')
        receipt = json.loads((self.root / 'RESULT.json').read_text())
        self.assertEqual(receipt['requiredModes'], ['scheduled-task'])
        self.assertEqual(len(receipt['cells']), 1)

    def test_child_timeout_is_joined(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        try:
            prove.join_child(child, .05)
            self.assertIsNotNone(child.poll())
        finally:
            if child.poll() is None:
                child.kill(); child.wait()


if __name__ == '__main__':
    unittest.main()
