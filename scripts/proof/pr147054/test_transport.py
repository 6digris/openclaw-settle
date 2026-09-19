import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import transport as t


def fixture():
    asset = {'id': 2, 'state': 'uploaded', 'name': t.NAME, 'size': t.SIZE, 'digest': 'sha256:' + t.SHA}
    release = {'id': 1, 'draft': True, 'tag_name': t.TAG, 'target_commitish': t.CANDIDATE,
               'name': t.TITLE, 'body': t.BODY, 'assets': [asset.copy()]}
    return release, asset, {'releaseId': 1, 'assetId': 2}


class TransportControls(unittest.TestCase):
    def test_accept_exact_pair(self):
        t.validate_pair(*fixture())

    def test_reject_wrong_identity_digest_ownership_and_published_release(self):
        mutations = [(0, 'draft', False), (0, 'target_commitish', t.COMPILED),
                     (0, 'body', 'foreign'), (0, 'tag_name', 'v1'), (0, 'id', 8),
                     (1, 'digest', 'sha256:' + '0' * 64), (1, 'size', t.SIZE + 1),
                     (1, 'name', 'dist.zip'), (1, 'id', 3), (1, 'state', 'starter')]
        for idx, key, value in mutations:
            with self.subTest(key=key, value=value):
                args = list(copy.deepcopy(fixture()))
                args[idx][key] = value
                with self.assertRaises(ValueError):
                    t.validate_pair(*args)

    def test_reject_extra_or_unbound_asset(self):
        for ids in ([2, 3], [3], []):
            release, asset, selected = fixture()
            release['assets'] = [dict(asset, id=i) for i in ids]
            with self.assertRaises(ValueError):
                t.validate_pair(release, asset, selected)

    def test_reject_non_integer_ids_and_extra_inputs(self):
        for value in ({'releaseId': True, 'assetId': 2}, {'releaseId': '1', 'assetId': 2},
                      {'releaseId': 1, 'assetId': -1}, {'releaseId': 1, 'assetId': 2, 'url': 'x'}):
            with self.assertRaises(ValueError):
                t.binding(value)

    def test_wrong_tarball_rejected_before_remote_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory) / t.NAME
            package.write_bytes(b'wrong package')
            with patch.object(t.subprocess, 'run') as run:
                with self.assertRaises(ValueError):
                    t.stage(package, {})
                run.assert_not_called()

    def test_wrong_tarball_produces_completed_failure_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            package = base / t.NAME
            package.write_bytes(b'wrong package')
            result = subprocess.run([sys.executable, '-B', str(Path(t.__file__)), 'stage',
                                     '--root', str(base / 'run'), '--package', str(package)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            receipt = json.loads((base / 'run/receipt.json').read_text())
            self.assertEqual(receipt['status'], 'FAIL')
            self.assertIn('completedAt', receipt)
            self.assertNotIn('releaseId', receipt)

    def test_corrupt_download_rejected_and_partial_removed(self):
        release, asset, selected = fixture()
        def download(*args, **kwargs):
            kwargs['stdout'].write(b'bad download')
            return subprocess.CompletedProcess(args, 0)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(t, 'api', side_effect=[release, asset]), patch.object(t.subprocess, 'run', side_effect=download):
                with self.assertRaises(ValueError):
                    t.fetch(root, selected, {})
            self.assertEqual(list((root / 'package').iterdir()), [])
            self.assertFalse((root / (t.NAME + '.partial')).exists())

    def test_wrong_remote_asset_never_downloaded(self):
        release, asset, selected = fixture()
        asset['digest'] = 'sha256:' + '0' * 64
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(t, 'api', side_effect=[release, asset]), patch.object(t.subprocess, 'run') as run:
                with self.assertRaises(ValueError):
                    t.fetch(Path(directory), selected, {})
                run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
