import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectInputs } from './build-inputs.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'mosaic-inputs-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

test('stale Cargo lock is rejected without being rewritten', t => {
  const dir = fixture(t);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/lib.rs'), 'pub fn value() -> u8 { 1 }');
  const manifest = version => `[package]\nname="lock-fixture"\nversion="${version}"\nedition="2021"\n`;
  writeFileSync(join(dir, 'Cargo.toml'), manifest('0.1.0'));
  execFileSync('cargo', ['generate-lockfile', '--offline'], { cwd: dir });
  const before = readFileSync(join(dir, 'Cargo.lock'));
  writeFileSync(join(dir, 'Cargo.toml'), manifest('0.2.0'));
  const result = spawnSync('cargo', ['check', '--locked', '--offline'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--locked/);
  assert.deepEqual(readFileSync(join(dir, 'Cargo.lock')), before);
});

test('lock guard fails on silent mutation and preserves command failures', t => {
  const dir = fixture(t);
  for (const name of ['Cargo.lock', 'pnpm-lock.yaml']) writeFileSync(join(dir, name), 'original');
  const run = command => spawnSync('bash', ['-c', 'source "$1"; eval "$2"', 'fixture', join(root, 'scripts/lockfiles.sh'), command], { cwd: dir });
  assert.equal(run('true').status, 0);
  assert.equal(run('exit 7').status, 7);
  assert.equal(run('printf mutated > Cargo.lock').status, 1);
  assert.equal(run('rm pnpm-lock.yaml').status, 1);
});

test('metadata records actual source/tools and artifacts; refuses symlinks', async t => {
  const dir = fixture(t), artifacts = join(dir, 'assets');
  mkdirSync(artifacts);
  for (const name of ['Cargo.lock', 'pnpm-lock.yaml', 'rust-toolchain.toml', '.nvmrc', 'package.json']) writeFileSync(join(dir, name), readFileSync(join(root, name)));
  writeFileSync(join(artifacts, 'fixture.tar.gz'), 'archive bytes');
  const run = (cmd, args) => cmd === 'git' ? (args[0] === 'rev-parse' ? 'a'.repeat(40) : '') : `${cmd} fixture-version`;
  const record = await collectInputs(dir, artifacts, run);
  assert.equal(record.source.commit, 'a'.repeat(40));
  assert.equal(record.source.dirty, false);
  assert.equal(record.tools.pnpm, 'pnpm fixture-version');
  assert.equal(record.artifacts[0].bytes, 13);
  const oldHash = record.artifacts[0].sha256;
  writeFileSync(join(artifacts, 'fixture.tar.gz'), 'changed bytes');
  assert.notEqual((await collectInputs(dir, artifacts, run)).artifacts[0].sha256, oldHash);
  symlinkSync(join(dir, 'Cargo.lock'), join(artifacts, 'escape'));
  await assert.rejects(() => collectInputs(dir, artifacts, run), /symlink refused/);
});
