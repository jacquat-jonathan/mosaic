import importlib.util
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / f'{name}.py')
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


coverage = module('coverage-report')
feedback = module('ci-feedback')


class CoverageFeedbackTests(unittest.TestCase):
    def test_source_paths_spaces_and_duplicate_records(self):
        root = Path('/checkout')
        data = 'SF:src/a b.ts\nDA:2,0\nDA:3,1\nend_of_record\nSF:/checkout/ui/src/a b.ts\nDA:2,4\nend_of_record\n'
        self.assertEqual(coverage.parse_lcov(data, root, root / 'ui'), {'ui/src/a b.ts': {2: 4, 3: 1}})
        with self.assertRaises(ValueError):
            coverage.parse_lcov('SF:../../secret\nDA:1,1', root, root / 'ui')

    def test_empty_and_zero_coverage_are_not_reported_as_full(self):
        for data in ['', 'SF:a.ts\nend_of_record', 'DA:1,1']:
            with self.assertRaises(ValueError):
                coverage.parse_lcov(data, Path('/checkout'), Path('/checkout'))
        files = coverage.parse_lcov('SF:a.ts\nDA:1,0\nend_of_record', Path('/checkout'), Path('/checkout'))
        report = coverage.summarize(files, {'a.ts': {1}, 'missing.ts': {1}}, {'Core': ['a.ts']})
        self.assertEqual(report['domains']['Core']['percent'], 0)
        self.assertIsNone(report['domains']['Other']['percent'])
        self.assertEqual(report['changed_files'][0]['uncovered'], [1])
        self.assertEqual(report['unmeasured_changed_files'], ['missing.ts'])

    def test_added_changed_deleted_lines_and_non_executable_lines(self):
        diff = '+++ b/ui/src/a b.ts\n@@ -1,2 +1,3 @@\n+x\ndiff --git a/new.ts b/new.ts\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\ndiff --git a/deleted.ts b/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n'
        changed = coverage.changed_lines(diff)
        self.assertEqual(changed, {'ui/src/a b.ts': {1, 2, 3}, 'new.ts': {1}})
        report = coverage.summarize({'ui/src/a b.ts': {1: 1, 3: 0}}, changed, {})
        self.assertEqual(report['changed_files'][0]['total'], 2)
        self.assertEqual(report['changed_files'][0]['uncovered'], [3])


    def test_diff_source_headers_and_git_quoted_paths(self):
        # Real Git output: header-like added source must not redirect later hunks.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root, text=True)
            git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
            names = ['real.ts', 'é file.ts', 'odd\vfile.ts']
            for name in names:
                (root / name).write_text('before\n' + 'unchanged\n' * 8 + 'last\n')
            git('add', '.'); git('commit', '-qm', 'base')
            for name in names:
                (root / name).write_text('++ b/not-a-path.ts\n' + 'unchanged\n' * 8 + 'changed\n')
            git('add', '.'); git('commit', '-qm', 'head')
            diff = git('-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-renames', '--unified=0', 'HEAD~1', 'HEAD', '--')
            self.assertEqual(coverage.changed_lines(diff), {name: {1, 10} for name in names})

    def test_deleted_hunk_has_no_changed_lines(self):
        self.assertEqual(coverage.changed_lines('+++ b/a.ts\n@@ -1,2 +0,0 @@'), {'a.ts': set()})

    def test_policy_preserves_floors_and_override_cannot_lower_gate(self):
        policy = json.loads((ROOT / 'coverage-policy.json').read_text())
        self.assertEqual(policy['ui_merged'], dict.fromkeys(['lines', 'statements', 'branches', 'functions'], 70))
        self.assertEqual(policy['rust']['lines'], 70)
        for override, success in [('69', False), ('nan', False), ('101', False), ('80', True)]:
            result = subprocess.run(['python3', str(ROOT / 'scripts/coverage-policy.py'), 'ui_merged', 'lines', 'TEST_FLOOR'], env={**os.environ, 'TEST_FLOOR': override}, capture_output=True)
            self.assertEqual(result.returncode == 0, success)

    def test_rejected_override_stops_shell_before_nyc_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'ui/scripts').mkdir(parents=True)
            (root / 'ui/.nyc_output').mkdir()
            (root / 'scripts').mkdir()
            (root / 'bin').mkdir()
            for file in ['ui/scripts/coverage.sh', 'scripts/coverage-policy.py', 'scripts/coverage-report.py', 'coverage-policy.json']:
                shutil.copyfile(ROOT / file, root / file)
            for layer in ['unit', 'e2e']:
                (root / f'ui/.nyc_output/{layer}-fixture.json').write_text('{}')
            fake = root / 'bin/pnpm'
            fake.write_text("#!/bin/sh\nif [ \"$3\" = report ]; then mkdir -p coverage; printf 'SF:src/a.ts\\nDA:1,1\\nend_of_record\\n' > coverage/lcov.info; else touch gate-ran; fi\n")
            fake.chmod(0o755)
            result = subprocess.run(['bash', 'ui/scripts/coverage.sh', 'report'], cwd=root,
                                    env={**os.environ, 'PATH': str(root / 'bin') + ':' + os.environ['PATH'],
                                         'MOSAIC_UI_COVERAGE_MIN': '1', 'COVERAGE_BASE_SHA': ''}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'policy floor 70', result.stderr)
            self.assertFalse((root / 'ui/gate-ran').exists())

    def test_timing_cache_classes_and_missing_logs_are_explicit(self):
        for log, expected in [('Cache restored successfully', 'warm'), ('Cache not found for key x', 'cold'), ('Cache restored successfully\nCache not found', 'mixed'), ('', 'unknown'), (None, 'unknown')]:
            self.assertEqual(feedback.cache_evidence(log)['classification'], expected)
        job = {'name': 'UI', 'id': 1, 'conclusion': 'failure', 'started_at': '2026-11-06T00:00:00Z', 'completed_at': '2026-11-06T00:01:10Z', 'steps': []}
        summary = feedback.summarize_job(job, None)
        self.assertEqual(summary['duration_seconds'], 70)
        self.assertFalse(summary['logs_available'])
        self.assertEqual(summary['observed_test_retry_lines'], [])

    def test_report_cli_uses_actual_git_diff_and_lcov(self):
        # Use a real repository diff to verify line identity; the production parser receives exactly this format.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root, text=True)
            git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
            (root / 'a b.ts').write_text('first\nold\n')
            git('add', '.'); git('commit', '-qm', 'base')
            (root / 'a b.ts').write_text('first\nnew\nadded\n')
            git('add', '.'); git('commit', '-qm', 'head')
            diff = git('-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-renames', '--unified=0', 'HEAD~1', 'HEAD', '--')
            self.assertEqual(coverage.changed_lines(diff), {'a b.ts': {2, 3}})


if __name__ == '__main__':
    unittest.main()
