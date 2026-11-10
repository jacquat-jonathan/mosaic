// Inspect by default. Explicit --apply only adds missing assets; never deletes/replaces assets.
// --publish is separate. A published release is refused even when bytes match.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { preflight } from './release-preflight.mjs';
import { signedAssets, digest } from './release-assets.mjs';
export function draftPlan(release, expected, downloaded = new Map()) {
  assert(!release || (release.draft === true && !release.published_at), 'Published releases are immutable');
  const assets = release?.assets ?? [], missing = [];
  assert(assets.every(a => expected.has(a.name)), 'Draft contains unexpected assets; inspect manually');
  for (const [name, bytes] of expected) {
    const matches = assets.filter(a => a.name === name);
    assert(matches.length <= 1, `Duplicate asset: ${name}`);
    if (!matches.length) { missing.push(name); continue; }
    const actual = downloaded.get(matches[0].id);
    assert(Buffer.isBuffer(actual), `Cannot verify remote asset: ${name}`);
    assert.equal(digest(actual), digest(bytes), `Existing draft asset differs: ${name}; refusing replacement`);
  }
  return missing;
}
export function recover({ root = process.cwd(), dir, tag, apply = false, publish = false, repo = 'jacquat-jonathan/mosaic', gh, verifySource = preflight }) {
  assert(!publish || apply, '--publish requires --apply');
  assert.match(repo, /^[\w.-]+\/[\w.-]+$/);
  verifySource({ cwd: root, tag, repo });
  const version = tag.slice(1), expected = signedAssets(root, dir, version);
  const command = gh ?? ((args, binary = false) => execFileSync('gh', args, { cwd: root, encoding: binary ? undefined : 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  const api = path => JSON.parse(command(['api', path]));
  const find = () => {
    // Listing authenticated releases distinguishes absence from denied/failed reads.
    for (let page = 1; page <= 100; page++) {
      const releases = api(`repos/${repo}/releases?per_page=100&page=${page}`);
      assert(Array.isArray(releases), 'Invalid release response');
      const found = releases.find(r => r.tag_name === tag);
      if (found) return api(`repos/${repo}/releases/${found.id}`);
      if (releases.length < 100) return null;
    }
    throw new Error('Release listing truncated; refuse unknown publication state');
  };
  const inspect = () => {
    const release = find();
    assert(!release || (release.tag_name === tag && release.draft && !release.published_at), 'Published releases are immutable');
    const downloaded = new Map();
    for (const asset of release?.assets ?? []) downloaded.set(asset.id, command(['api', `repos/${repo}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'], true));
    return { release, missing: draftPlan(release, expected, downloaded) };
  };
  let state = inspect();
  if (!apply) return { tag, draft: !!state.release, missing: state.missing, action: 'inspection-only' };
  const notes = join(dir, 'release-notes.md');
  assert(lstatSync(notes).isFile(), 'Release notes must be a regular file');
  assert(readFileSync(notes, 'utf8').trim(), 'Missing release notes');
  if (!state.release) {
    verifySource({ cwd: root, tag, repo });
    command(['release', 'create', tag, '--repo', repo, '--verify-tag', '--draft', '--title', `Mosaic ${version}`, '--notes-file', notes]);
    state = inspect();
  }
  for (const name of state.missing) {
    verifySource({ cwd: root, tag, repo });
    const latest = inspect();
    assert(latest.release, 'Draft disappeared');
    if (latest.missing.includes(name)) command(['release', 'upload', tag, join(dir, name), '--repo', repo]); // deliberately no --clobber
  }
  state = inspect();
  assert.equal(state.missing.length, 0, 'Draft assets incomplete');
  if (publish) {
    verifySource({ cwd: root, tag, repo });
    state = inspect();
    assert(state.release && state.missing.length === 0, 'Draft changed before publication');
    command(['release', 'edit', tag, '--repo', repo, '--verify-tag', '--title', `Mosaic ${version}`, '--notes-file', notes, '--prerelease=false', '--draft=false']);
  }
  return { tag, action: publish ? 'published' : 'draft-complete', releaseId: state.release.id };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tag, dir, ...flags] = process.argv.slice(2);
  assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/);
  assert(dir && flags.every(f => ['--apply', '--publish'].includes(f)), 'Usage: recover-release-draft.mjs vX.Y.Z ASSET_DIR [--apply] [--publish]');
  console.log(JSON.stringify(recover({ root: resolve(import.meta.dirname, '..'), dir: resolve(dir), tag, apply: flags.includes('--apply'), publish: flags.includes('--publish'), repo: process.env.GH_REPO }), null, 2));
}
