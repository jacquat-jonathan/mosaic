#!/usr/bin/env python3
"""Record observed job timings/cache evidence; never infer cold/warm from run order."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import re
import subprocess


def seconds(start, end):
    if not start or not end or end.startswith('0001-'):
        return None
    return max(0, (datetime.fromisoformat(end.replace('Z', '+00:00')) -
                   datetime.fromisoformat(start.replace('Z', '+00:00'))).total_seconds())


def cache_evidence(log):
    log = log or ''
    hits = sorted(set(re.findall(r'(?:Cache hit for:|Cache restored successfully|Restored from cache key)[^\r\n]*', log)))
    misses = sorted(set(re.findall(r'(?:Cache not found|No cache found|No cache found for)[^\r\n]*', log)))
    return {'classification': 'mixed' if hits and misses else 'warm' if hits else 'cold' if misses else 'unknown',
            'hits': hits, 'misses': misses}


def summarize_job(job, log):
    retries = sorted(set(re.findall(r'\[\d+/\d+\].*\(retry #\d+\)', log or '')))
    return {'name': job['name'], 'id': job['id'], 'conclusion': job['conclusion'],
            'runner_name': job.get('runner_name'), 'labels': job.get('labels', []),
            'duration_seconds': seconds(job.get('started_at'), job.get('completed_at')),
            'cache': cache_evidence(log),
            'observed_test_retry_lines': retries, 'logs_available': log is not None,
            'steps': [{'name': step['name'], 'conclusion': step.get('conclusion'),
                       'duration_seconds': seconds(step.get('started_at'), step.get('completed_at'))}
                      for step in job.get('steps', [])]}


def gh(*args):
    return subprocess.check_output(['gh', 'api', *args], text=True)


def markdown(report):
    lines = ['## CI timing and failure evidence', '',
             f'Run [{report["run_id"]}]({report["url"]}), attempt {report["attempt"]}, source `{report["source"]}`.', '',
             'Cache class comes only from retained log evidence; unknown is not cold. '
             'Job duration includes setup and excludes queue time. Retries shown are observed runner lines, not a flake rate.', '',
             '| Job | Result | Seconds | Cache evidence | Observed test retries |', '| --- | --- | ---: | --- | ---: |']
    for job in report['jobs']:
        lines.append(f'| {job["name"]} | {job["conclusion"]} | {job["duration_seconds"]} | '
                     f'{job["cache"]["classification"]} | {len(job["observed_test_retry_lines"])} |')
    failed = [job for job in report['jobs'] if job['conclusion'] != 'success']
    if failed:
        lines += ['', '### Failure triage', '']
        for job in failed:
            steps = ', '.join(step['name'] for step in job['steps'] if step['conclusion'] == 'failure') or 'No failed step recorded; inspect runner/cancellation state'
            lines.append(f'- {job["name"]}: {steps}. [Job logs]({report["url"]}/job/{job["id"]}).')
        lines += ['', 'Inspect existing E2E trace/video/screenshot artifacts before changing retries. The aggregate coverage job intentionally fails when an input test job fails.']
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--run', required=True)
    parser.add_argument('--attempt', type=int)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo) or not args.run.isdecimal():
        raise SystemExit('Expected owner/repository and numeric run id')
    run = json.loads(gh(f'repos/{args.repo}/actions/runs/{args.run}'))
    attempt = args.attempt or run['run_attempt']
    pages = json.loads(gh('--paginate', '--slurp', f'repos/{args.repo}/actions/runs/{args.run}/attempts/{attempt}/jobs?per_page=100'))
    report = {'run_id': args.run, 'attempt': attempt, 'source': run['head_sha'], 'url': run['html_url'], 'jobs': []}
    for job in (job for page in pages for job in page['jobs']):
        if job['status'] != 'completed' or job['name'] == 'CI feedback':
            continue
        try:
            log = gh(f'repos/{args.repo}/actions/jobs/{job["id"]}/logs')
        except subprocess.CalledProcessError:
            log = None
        report['jobs'].append(summarize_job(job, log))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.with_suffix('.json').write_text(json.dumps(report, indent=2) + '\n')
    document = markdown(report)
    args.output.with_suffix('.md').write_text(document)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as output:
            output.write(document)


if __name__ == '__main__':
    main()
