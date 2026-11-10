// Read-only: no fetch, checkout, ref mutation, build, signing or publication.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { releaseNotes } from './release-notes.mjs';
export const requiredJobs = ['Rust', 'UI checks', 'E2E Chrome (1/2)', 'E2E Chrome (2/2)', 'E2E WebKit (1/2)', 'E2E WebKit (2/2)', 'UI coverage'];
const exec = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export function verifyChecks(runs, jobs, sha) {
  const matching = runs.filter(r => r.head_sha === sha && r.head_branch === 'main' && r.event === 'push' && r.path === '.github/workflows/check.yml');
  matching.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  const run = matching[0];
  assert(run, `No main Check run for ${sha}`);
  assert(run.status === 'completed' && run.conclusion === 'success', 'Latest main Check run is not successful');
  for (const name of requiredJobs) {
    const found = jobs.filter(j => j.name === name);
    assert(found.length === 1 && found[0].status === 'completed' && found[0].conclusion === 'success', `Required job not successful: ${name}`);
  }
  assert(jobs.every(j => j.status === 'completed' && j.conclusion === 'success'), 'Check run includes unsuccessful jobs');
  return run;
}
export function preflight({ cwd = process.cwd(), tag, local = false, repo = 'jacquat-jonathan/mosaic', api } = {}) {
  assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/, 'Expected vX.Y.Z tag');
  assert.match(repo, /^[\w.-]+\/[\w.-]+$/, 'Invalid repository');
  const git = (...args) => exec('git', args, cwd);
  const ref = `refs/tags/${tag}`, version = tag.slice(1);
  assert.equal(git('cat-file', '-t', ref), 'tag', 'Release tag must be annotated');
  const tagObject = git('rev-parse', ref), commit = git('rev-parse', `${ref}^{commit}`);
  assert.equal(git('rev-parse', 'HEAD'), commit, 'Checkout must be exact tagged release commit');
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Tracked source must be clean');
  assert.equal(git('show', '-s', '--format=%s', commit), `Release ${version}`, 'Wrong release commit title');
  const source = file => git('show', `${commit}:${file}`);
  const cargo = source('Cargo.toml').match(/\[workspace.package\]([\s\S]*?)(?:\n\[|$)/)?.[1];
  assert.equal(cargo?.match(/^version\s*=\s*"([^"]+)"/m)?.[1], version, 'Cargo version mismatch');
  assert.equal(JSON.parse(source('src-tauri/tauri.conf.json')).version, version, 'App version mismatch');
  for (const name of ['mosaic-app', 'mosaic-cli', 'mosaic-core']) {
    const packages = source('Cargo.lock').split('[[package]]').filter(p => new RegExp(`^name = "${name}"$`, 'm').test(p));
    assert.equal(packages.length, 1, `Lock package ${name}`);
    assert.equal(packages[0].match(/^version = "([^"]+)"/m)?.[1], version, `Lock version ${name}`);
  }
  const changelog = source('CHANGELOG.md');
  assert.equal(releaseNotes(changelog, 'Unreleased', { allowEmpty: true }).notes.length, 0, 'Unreleased must be empty');
  releaseNotes(changelog, version);
  const result = { tag, tagObject, commit, version, mode: local ? 'local-metadata-only' : 'publication-preflight' };
  if (local) return result;
  const main = git('rev-parse', 'refs/remotes/origin/main');
  git('merge-base', '--is-ancestor', commit, main);
  const remote = new Map(git('ls-remote', 'origin', ref, `${ref}^{}`, 'refs/heads/main').split('\n').map(line => line.split(/\s+/).reverse()));
  assert.equal(remote.get(ref), tagObject, 'Remote tag object changed or missing');
  assert.equal(remote.get(`${ref}^{}`), commit, 'Remote tag target changed');
  assert.equal(remote.get('refs/heads/main'), main, 'origin/main is stale; fetch and retry');
  // The earliest first-parent main commit containing the release is the intended merge,
  // not whatever newer commit happens to be main today.
  const firstParent = git('rev-list', '--first-parent', '--reverse', main).split('\n');
  let low = 0, high = firstParent.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    try { git('merge-base', '--is-ancestor', commit, firstParent[middle]); high = middle; }
    catch (error) {
      if (error.status !== 1) throw error; // Git errors are unknown ancestry, not a negative result.
      low = middle + 1;
    }
  }
  const merge = firstParent[low];
  assert(merge, 'No containing main commit');
  const get = api ?? (path => JSON.parse(exec('gh', ['api', path], cwd)));
  const runData = get(`repos/${repo}/actions/workflows/check.yml/runs?branch=main&event=push&head_sha=${merge}&per_page=100`);
  const runs = runData.workflow_runs;
  assert(Array.isArray(runs) && Number.isSafeInteger(runData.total_count) && runData.total_count >= 0 && runData.total_count <= 100 && runs.length === runData.total_count, 'Ambiguous or truncated Check run history');
  const candidates = runs.filter(r => r.head_sha === merge && r.head_branch === 'main' && r.event === 'push' && r.path === '.github/workflows/check.yml').sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  assert(candidates[0], 'No Check run for intended main merge');
  const run = candidates[0];
  const jobs = [];
  let jobCount;
  for (let page = 1; ; page++) {
    const data = get(`repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
    assert(Array.isArray(data.jobs) && Number.isSafeInteger(data.total_count) && data.total_count >= 0, 'Missing jobs response');
    jobCount ??= data.total_count;
    assert.equal(data.total_count, jobCount, 'Job count changed during pagination');
    jobs.push(...data.jobs);
    assert(jobs.length <= jobCount, 'Inconsistent jobs response');
    if (jobs.length === jobCount) break;
    assert(data.jobs.length && page < 20, 'Truncated jobs response');
  }
  verifyChecks(runs, jobs, merge);
  return { ...result, main, merge, checkRun: run.id, checkAttempt: run.run_attempt };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), tag = args.find(a => /^v\d/.test(a));
  assert(args.every(a => a === tag || a === '--local'), 'Usage: release-preflight.mjs vX.Y.Z [--local]');
  console.log(JSON.stringify(preflight({ tag, local: args.includes('--local'), repo: process.env.GH_REPO }), null, 2));
}
