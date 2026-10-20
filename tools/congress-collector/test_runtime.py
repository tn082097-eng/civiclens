"""Runtime governance tests; no downloaded code executes in the host namespace."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('collector_runtime', HERE / 'runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeTests(unittest.TestCase):
    def test_vendor_bytes(self):
        manifest = runtime.verify_vendor()
        self.assertEqual(manifest['commit'], runtime.COMMIT)
        self.assertEqual(len(manifest['files']), 5)

    def test_vendor_tamper(self):
        # SYNTHETIC copied tree with altered source.
        import shutil
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / 'vendor'
            shutil.copytree(runtime.VENDOR, dest)
            (dest / 'congress/tasks/vote_info.py').write_text('tampered')
            with self.assertRaisesRegex(ValueError, 'vendor hash'):
                runtime.verify_vendor(dest)

    def test_runtime_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, 'runtime missing'):
                runtime.check_runtime(Path(tmp))

    def test_runtime_stale(self):
        # SYNTHETIC metadata, never a usable runtime.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'venv/bin').mkdir(parents=True)
            (root / 'venv/bin/python').touch()
            (root / 'runtime.json').write_text(json.dumps({'lock_sha256': '0'*64}))
            with self.assertRaisesRegex(ValueError, 'runtime stale'):
                runtime.check_runtime(root)

    def test_installed_runtime(self):
        data = runtime.check_runtime()
        self.assertIn('lxml', data['packages'])
        self.assertIn('scrapelib', data['packages'])
        self.assertIn('pytz', data['packages'])
        self.assertTrue(data['python'].startswith('3.12.'))


if __name__ == '__main__':
    unittest.main()
