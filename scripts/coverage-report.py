#!/usr/bin/env python3
"""Supplement existing gates with measured LCOV domains and changed executable lines."""
import argparse
import ast
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def source_path(raw, root, source_root):
    path = Path(raw)
    if not path.is_absolute():
        path = source_root / path
    # Coverage describes source names, not files to open. Normalize without following symlinks.
    path = Path(os.path.abspath(path))
    try:
        return path.relative_to(root).as_posix()
    except ValueError as error:
        raise ValueError(f'LCOV source outside checkout: {raw}') from error


def parse_lcov(text, root, source_root):
    files, current = {}, None
    for line in text.splitlines():
        if line.startswith('SF:'):
            current = source_path(line[3:], root, source_root)
            files.setdefault(current, {})
        elif line.startswith('DA:'):
            if current is None:
                raise ValueError('LCOV line data without a source')
            fields = line[3:].split(',')
            number, hits = int(fields[0]), int(fields[1])
            if number < 1 or hits < 0:
                raise ValueError('Invalid LCOV line or hit count')
            files[current][number] = max(hits, files[current].get(number, 0))
        elif line == 'end_of_record':
            current = None
    if not files or not any(files.values()):
        raise ValueError('LCOV contains no measured executable lines')
    return files


def changed_lines(diff):
    result, path, in_header = {}, None, True
    for line in diff.split('\n'):
        if line.startswith('diff --git '):
            path, in_header = None, True
        elif in_header and line.startswith('+++ '):
            raw = line[4:]
            # Git uses C quoting (including octal, \a and \v), not JSON quoting.
            path = ast.literal_eval(raw) if raw.startswith('"') else raw.rstrip('\t')
            if path == '/dev/null':
                path = None
            elif path.startswith('b/'):
                path = path[2:]
                result.setdefault(path, set())
            else:
                raise ValueError(f'Unexpected diff path: {path}')
        elif line.startswith('@@') and path is not None:
            in_header = False
            match = re.match(r'@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@', line)
            if not match:
                raise ValueError('Invalid diff hunk')
            start, count = int(match[1]), int(match[2] or 1)
            result[path].update(range(start, start + count))
    return result


def stats(lines):
    covered = sum(hits > 0 for hits in lines)
    return {'covered': covered, 'total': len(lines),
            'percent': round(100 * covered / len(lines), 2) if lines else None}


def summarize(files, changed, domains):
    buckets = {name: [] for name in domains}
    buckets['Other'] = []
    uncovered = []
    for path, lines in sorted(files.items()):
        domain = next((name for name, prefixes in domains.items()
                       if any(path.startswith(prefix) for prefix in prefixes)), 'Other')
        buckets[domain].extend(lines.values())
        missing = [number for number, hits in sorted(lines.items()) if hits == 0]
        if missing:
            uncovered.append({'path': path, 'domain': domain, 'lines': missing})
    changes, unmeasured = [], []
    for path, lines in sorted(changed.items()):
        if not lines:
            continue
        if path not in files:
            unmeasured.append(path)
            continue
        executable = {line: files[path][line] for line in lines if line in files[path]}
        changes.append({'path': path, **stats(list(executable.values())),
                        'uncovered': sorted(n for n, hits in executable.items() if not hits)})
    return {'domains': {name: stats(lines) for name, lines in buckets.items()},
            'changed_files': changes, 'unmeasured_changed_files': unmeasured,
            'uncovered_files': uncovered}


def markdown(report):
    def percent(value):
        return 'N/A (no executable lines)' if value is None else f'{value:.2f}%'
    def safe(value):
        return value.replace('|', '\\|').replace('\n', ' ')
    rows = [f'## {report["label"]} coverage evidence', '',
            f'Changed lines compared with `{report["base"] or "unavailable"}`. '
            'These diagnostic line metrics supplement, and do not replace, the required gates.', '',
            '| Domain | Covered / executable lines | Coverage |', '| --- | ---: | ---: |']
    for name, data in report['domains'].items():
        rows.append(f'| {name} | {data["covered"]} / {data["total"]} | {percent(data["percent"])} |')
    rows += ['', '### Changed source lines', '', '| File | Covered / executable | Uncovered line numbers |', '| --- | ---: | --- |']
    for item in report['changed_files']:
        rows.append(f'| {safe(item["path"])} | {item["covered"]} / {item["total"]} | '
                    + ', '.join(map(str, item['uncovered'][:40])) + ' |')
    if not report['changed_files']:
        rows.append('| No changed instrumented source | — | — |')
    if report['unmeasured_changed_files']:
        rows += ['', 'Changed files without coverage data (not counted as covered; may be tests/configuration):', '']
        rows += ['- ' + safe(path) for path in report['unmeasured_changed_files'][:50]]
    rows += ['', '### Uncovered paths by domain', '',
             'First 25 files; complete line lists are in the JSON artifact. Review persistence, planner and IPC failures first.', '']
    for item in report['uncovered_files'][:25]:
        rows.append(f'- {safe(item["path"])} ({item["domain"]}): ' + ', '.join(map(str, item['lines'][:40])))
    return '\n'.join(rows) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('lcov', type=Path)
    parser.add_argument('--source-root', type=Path, default=ROOT)
    parser.add_argument('--base', default=os.environ.get('COVERAGE_BASE_SHA', ''))
    parser.add_argument('--label', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    files = parse_lcov(args.lcov.read_text(), ROOT, args.source_root.resolve())
    base, changes = None, {}
    if args.base:
        base = subprocess.check_output(['git', 'rev-parse', '--verify', args.base + '^{commit}'], cwd=ROOT, text=True).strip()
        diff = subprocess.check_output(['git', '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-renames', '--unified=0', base, 'HEAD', '--'], cwd=ROOT, text=True)
        changes = changed_lines(diff)
    policy = json.loads((ROOT / 'coverage-policy.json').read_text())
    report = {'label': args.label, 'base': base, **summarize(files, changes, policy['domains'])}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.with_suffix('.json').write_text(json.dumps(report, indent=2) + '\n')
    document = markdown(report)
    args.output.with_suffix('.md').write_text(document)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
            summary.write(document)


if __name__ == '__main__':
    main()
