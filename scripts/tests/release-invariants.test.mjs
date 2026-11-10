import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { preflight, requiredJobs, verifyChecks } from '../release-preflight.mjs';
import { releaseNotes, notesMarkdown, releaseDocument } from '../release-notes.mjs';
import { digest, signedAssets } from '../release-assets.mjs';
import { recover, draftPlan } from '../recover-release-draft.mjs';
const source = resolve(import.meta.dirname, '../..');
function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'mosaic-release-test-')), root = join(temp, 'source'), remote = join(temp, 'remote.git');
  t.after(() => rmSync(temp, { recursive: true, force: true })); mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'commit.gpgsign', 'false'); git('config', 'tag.gpgsign', 'false');
  mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(join(root, 'src-tauri'));
  for (const f of ['release.sh', 'release-notes.mjs', 'sign-release.mjs']) cpSync(join(source, 'scripts', f), join(root, 'scripts', f));
  for (const name of ['mosaic-app', 'mosaic-cli', 'mosaic-core']) {
    mkdirSync(join(root, name, 'src'), { recursive: true });
    writeFileSync(join(root, name, 'Cargo.toml'), `[package]\nname = "${name}"\nversion.workspace = true\nedition = "2021"\n`);
    writeFileSync(join(root, name, 'src/lib.rs'), 'pub fn fixture() {}\n');
  }
  const metadata = (version, released = false) => {
    writeFileSync(join(root, 'Cargo.toml'), `[workspace]\nmembers = ["mosaic-app", "mosaic-cli", "mosaic-core"]\nresolver = "2"\n[workspace.package]\nversion = "${version}"\n`);
    writeFileSync(join(root, 'Cargo.lock'), 'version = 4\n' + ['mosaic-app', 'mosaic-cli', 'mosaic-core'].map(n => `\n[[package]]\nname = "${n}"\nversion = "${version}"\n`).join(''));
    writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version, identifier: 'fixture.mosaic' }, null, 2) + '\n');
    writeFileSync(join(root, 'CHANGELOG.md'), `# Changes\n\n## Unreleased\n\n${released ? `## ${version} — 2026-11-09\n\n` : ''}- A complete bullet\n  with a wrapped continuation.\n`);
  };
  metadata('0.1.0'); git('add', '.'); git('commit', '-m', 'Base');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' }); git('remote', 'add', 'origin', remote); git('push', '-u', 'origin', 'main');
  return { root, git, metadata, remote };
}
function released(t) {
  const f = fixture(t); f.git('checkout', '-b', 'release/0.2.0'); f.metadata('0.2.0', true); f.git('add', '.'); f.git('commit', '-m', 'Release 0.2.0');
  f.git('tag', '-a', 'v0.2.0', '-m', 'Mosaic 0.2.0'); return f;
}
function merge(f) {
  const commit = f.git('rev-parse', 'HEAD'); f.git('checkout', 'main'); f.git('merge', '--no-ff', 'release/0.2.0', '-m', 'Merge release PR');
  const sha = f.git('rev-parse', 'HEAD'); f.git('push', 'origin', 'main', 'refs/tags/v0.2.0'); f.git('checkout', 'release/0.2.0'); return { commit, sha };
}
const checks = sha => [{ id: 12, head_sha: sha, head_branch: 'main', event: 'push', path: '.github/workflows/check.yml', run_number: 4, run_attempt: 1, status: 'completed', conclusion: 'success' }];
const jobs = () => requiredJobs.map(name => ({ name, status: 'completed', conclusion: 'success' }));
const apiFor = sha => path => path.includes('/jobs?') ? { jobs: jobs(), total_count: requiredJobs.length } : { workflow_runs: checks(sha), total_count: 1 };
test('notes preserve wrapped/nested bullets and reject silently dropped prose', () => {
  const n = releaseNotes('## Unreleased\n- Hello\n  continued\n  - nested\n\n- Next\n## Old\n- Ignore', 'Unreleased');
  assert.equal(notesMarkdown(n.notes), '- Hello\n  continued\n  - nested\n- Next');
  assert.throws(() => releaseNotes('## Unreleased\n- One\nLost prose', 'Unreleased'), /Unsupported/);
  assert.throws(() => releaseNotes('## 0.1.0 — bad\n- One', '0.1.0'), /Malformed/);
  assert.throws(() => releaseNotes('## 0.1.0 — 2026-11-09\n- One\n## 0.1.0 — bad\n- Two', '0.1.0'), /Expected one/);
});
test('local metadata passes but is explicitly not publication proof', t => {
  const f = released(t); assert.equal(preflight({ cwd: f.root, tag: 'v0.2.0', local: true }).mode, 'local-metadata-only');
  assert.throws(() => preflight({ cwd: f.root, tag: 'v0.2.0' }));
});
test('rejects lightweight tag, wrong subject, version and changelog mismatch', t => {
  const f = released(t);
  f.git('tag', '-d', 'v0.2.0'); f.git('tag', 'v0.2.0');
  assert.throws(() => preflight({ cwd: f.root, tag: 'v0.2.0', local: true }), /annotated/);
  f.git('commit', '--amend', '-m', 'Not a release'); f.git('tag', '-fa', 'v0.2.0', '-m', 'tag');
  assert.throws(() => preflight({ cwd: f.root, tag: 'v0.2.0', local: true }), /title/);
  f.git('commit', '--amend', '-m', 'Release 0.2.0');
  writeFileSync(join(f.root, 'src-tauri/tauri.conf.json'), '{"version":"0.3.0"}'); f.git('add', '.'); f.git('commit', '--amend', '--no-edit'); f.git('tag', '-fa', 'v0.2.0', '-m', 'tag');
  assert.throws(() => preflight({ cwd: f.root, tag: 'v0.2.0', local: true }), /version mismatch/);
  f.metadata('0.2.0', false); f.git('add', '.'); f.git('commit', '--amend', '--no-edit'); f.git('tag', '-fa', 'v0.2.0', '-m', 'tag');
  assert.throws(() => preflight({ cwd: f.root, tag: 'v0.2.0', local: true }), /Unreleased/);
});
test('exact release commit survives merge; checks bind earliest containing main merge', t => {
  const f = released(t), { commit, sha } = merge(f);
  f.git('checkout', 'main'); f.git('commit', '--allow-empty', '-m', 'Later work'); f.git('push', 'origin', 'main'); f.git('checkout', 'release/0.2.0');
  const result = preflight({ cwd: f.root, tag: 'v0.2.0', api: apiFor(sha) });
  assert.equal(result.commit, commit); assert.equal(result.merge, sha); assert.notEqual(result.main, sha);
  assert.throws(() => preflight({ cwd: f.root, tag: 'v0.2.0', api: () => { throw Error('API unavailable'); } }), /API unavailable/);
  f.git('tag', '-fa', 'v0.2.0', '-m', 'Changed annotation');
  assert.throws(() => preflight({ cwd: f.root, tag: 'v0.2.0', api: apiFor(sha) }), /Remote tag object/);
});
test('checks fail closed for pending/latest failures/missing shards/wrong source', () => {
  const sha = 'a'.repeat(40), r = checks(sha); verifyChecks(r, jobs(), sha);
  assert.throws(() => verifyChecks([...r, { ...r[0], run_number: 5, conclusion: 'failure' }], jobs(), sha));
  assert.throws(() => verifyChecks(r, jobs().slice(1), sha), /Required/);
  assert.throws(() => verifyChecks(r, jobs(), 'b'.repeat(40)), /No main/);
});
test('preparation makes local annotated tag only and preserves complete notes', t => {
  const f = fixture(t); f.git('checkout', '-b', 'release/0.2.0');
  execFileSync('bash', ['scripts/release.sh', '0.2.0'], { cwd: f.root, env: { ...process.env, PATH: `${resolve(process.execPath, '..')}:${process.env.PATH}` }, stdio: 'pipe' });
  assert.equal(f.git('show', '-s', '--format=%s'), 'Release 0.2.0');
  assert.equal(f.git('cat-file', '-t', 'v0.2.0'), 'tag');
  assert.match(f.git('for-each-ref', '--format=%(contents)', 'refs/tags/v0.2.0'), /wrapped continuation/);
  assert.equal(f.git('ls-remote', 'origin', 'refs/tags/v0.2.0'), '');
  preflight({ cwd: f.root, tag: 'v0.2.0', local: true });
});
test('preparation rejects unmerged source and leaves repository untouched', t => {
  const f = fixture(t); f.git('checkout', '-b', 'release/0.2.0'); writeFileSync(join(f.root, 'mosaic-core/src/lib.rs'), 'pub fn unmerged() {}'); f.git('add', '.'); f.git('commit', '-m', 'Unmerged code');
  const sha = f.git('rev-parse', 'HEAD'); assert.throws(() => execFileSync('bash', ['scripts/release.sh', '0.2.0'], { cwd: f.root, stdio: 'pipe' }));
  assert.equal(f.git('rev-parse', 'HEAD'), sha); assert.equal(f.git('status', '--porcelain'), '');
});
function assets(t) {
  const f = fixture(t), dir = join(f.root, 'assets'); mkdirSync(dir); f.metadata('0.1.0', true);
  const sourceNotes = releaseNotes(readFileSync(join(f.root, 'CHANGELOG.md'), 'utf8'), '0.1.0');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(join(f.root, 'src-tauri/release-public-key.hex'), publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'));
  const archive = 'Mosaic-0.1.0-universal.tar.gz', dmg = 'Mosaic-0.1.0-universal.dmg';
  writeFileSync(join(dir, archive), 'fixture archive'); writeFileSync(join(dir, dmg), 'fixture dmg');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: '0.1.0', bundle_id: 'fixture.mosaic', archive, sha256: digest(Buffer.from('fixture archive')), size: 15, minimum_macos: '12.0', architectures: ['arm64', 'x86_64'], ...sourceNotes }));
  writeFileSync(join(dir, 'SHA256SUMS'), `${digest(Buffer.from('fixture dmg'))}  ${dmg}\n${digest(Buffer.from('fixture archive'))}  ${archive}\n`);
  writeFileSync(join(dir, 'release-notes.md'), releaseDocument(sourceNotes.notes));
  execFileSync(process.execPath, [join(f.root, 'scripts/sign-release.mjs'), dir], { env: { ...process.env, MOSAIC_RELEASE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), MOSAIC_RELEASE_KEY_FILE: '' }, stdio: 'pipe' });
  return { ...f, dir };
}
test('real signing validates fixture keys and rejects modified bytes', t => {
  const f = assets(t); assert.equal(signedAssets(f.root, f.dir, '0.1.0').size, 5);
  writeFileSync(join(f.dir, 'Mosaic-0.1.0-universal.dmg'), 'tampered'); assert.throws(() => signedAssets(f.root, f.dir, '0.1.0'), /checksums/);
});
test('draft inspection/resume is idempotent, never clobbers and refuses published assets', t => {
  const f = assets(t), expected = signedAssets(f.root, f.dir, '0.1.0'), uploads = [], remoteBytes = new Map();
  let failUpload = true;
  let release = { id: 1, tag_name: 'v0.1.0', draft: true, published_at: null, assets: [] };
  const gh = (args, binary) => {
    if (args[0] === 'api') {
      if (binary) return remoteBytes.get(Number(args[1].split('/').at(-1)));
      return JSON.stringify(args[1].includes('?') ? [release] : release);
    }
    assert(!args.includes('--clobber'));
    if (args[1] === 'upload') { if (uploads.length === 2 && failUpload) { failUpload = false; throw Error('Interrupted upload'); } const name = args[3].split('/').at(-1), id = release.assets.length + 1; uploads.push(name); release.assets.push({ name, id }); remoteBytes.set(id, expected.get(name)); }
    else if (args[1] === 'edit') { release.draft = false; release.published_at = 'now'; }
    else throw Error('Unexpected mutation');
    return '';
  };
  const opts = { root: f.root, dir: f.dir, tag: 'v0.1.0', gh, verifySource: () => ({}) };
  assert.equal(recover(opts).missing.length, 5); assert.equal(uploads.length, 0);
  assert.throws(() => recover({ ...opts, apply: true }), /Interrupted upload/);
  assert.equal(uploads.length, 2);
  recover({ ...opts, apply: true }); assert.equal(uploads.length, 5);
  recover({ ...opts, apply: true }); assert.equal(uploads.length, 5);
  recover({ ...opts, apply: true, publish: true });
  assert.throws(() => recover({ ...opts, apply: true }), /immutable/);
  assert.throws(() => draftPlan({ draft: true, assets: [{ id: 1, name: [...expected.keys()][0] }] }, expected, new Map([[1, Buffer.from('different')]])), /differs/);
});

test('release API failures never become permission to create or publish', t => {
  const f = assets(t);
  assert.throws(() => recover({ root: f.root, dir: f.dir, tag: 'v0.1.0', apply: true,
    verifySource: () => ({}), gh: args => { assert.equal(args[0], 'api'); throw Error('Denied'); } }), /Denied/);
});

test('publication refuses artifact notes not derived from tagged changelog', t => {
  const f = assets(t);
  writeFileSync(join(f.dir, 'release-notes.md'), '- Stale release notes\n');
  assert.throws(() => signedAssets(f.root, f.dir, '0.1.0'), /Publication notes/);
  const sourceNotes = releaseNotes(readFileSync(join(f.root, 'CHANGELOG.md'), 'utf8'), '0.1.0');
  writeFileSync(join(f.dir, 'release-notes.md'), releaseDocument(sourceNotes.notes));
  const manifest = JSON.parse(readFileSync(join(f.dir, 'manifest.json'), 'utf8'));
  manifest.notes = ['Stale manifest notes'];
  writeFileSync(join(f.dir, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(() => signedAssets(f.root, f.dir, '0.1.0'), /Manifest notes/);
});
test('preparation accepts parser-supported whitespace on Unreleased heading', t => {
  const f = fixture(t); f.git('checkout', '-b', 'release/0.2.0');
  const path = join(f.root, 'CHANGELOG.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('## Unreleased\n', '## Unreleased  \n'));
  f.git('add', '.'); f.git('commit', '-m', 'Release note preparation');
  execFileSync('bash', ['scripts/release.sh', '0.2.0'], { cwd: f.root, env: { ...process.env, PATH: `${resolve(process.execPath, '..')}:${process.env.PATH}` }, stdio: 'pipe' });
  preflight({ cwd: f.root, tag: 'v0.2.0', local: true });
});

test('preflight rejects inconsistent or incomplete API counts', t => {
  const f = released(t), { sha } = merge(f);
  assert.throws(() => preflight({ cwd: f.root, tag: 'v0.2.0', api: () => ({ workflow_runs: checks(sha), total_count: 2 }) }), /truncated/);
  assert.throws(() => preflight({ cwd: f.root, tag: 'v0.2.0', api: path => path.includes('/jobs?') ? { jobs: jobs(), total_count: requiredJobs.length - 1 } : { workflow_runs: checks(sha), total_count: 1 } }), /Inconsistent jobs/);
});
