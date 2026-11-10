import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseNotes, releaseDocument } from './release-notes.mjs';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// Built-ins only: the sign job must never install dependencies or execute build output.
export function signedAssets(root, dir, version) {
  const names = [`Mosaic-${version}-universal.dmg`, `Mosaic-${version}-universal.tar.gz`, 'manifest.json', 'manifest.sig', 'SHA256SUMS'];
  const files = new Map(names.map(name => {
    const path = join(dir, name);
    assert(lstatSync(path).isFile(), `Asset is not a regular file: ${name}`);
    return [name, readFileSync(path)];
  }));
  const manifest = JSON.parse(files.get('manifest.json'));
  const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json')));
  assert.equal(config.version, version, 'Source version mismatch');
  assert.equal(manifest.version, version, 'Manifest version mismatch');
  const sourceNotes = releaseNotes(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
  assert.deepEqual(manifest.notes, sourceNotes.notes, 'Manifest notes differ from source changelog');
  assert.equal(manifest.date, sourceNotes.date, 'Manifest date differs from source changelog');
  assert.equal(manifest.minimum_macos, '12.0', 'Unsupported minimum macOS');
  assert.deepEqual(manifest.architectures, ['arm64', 'x86_64'], 'Expected universal architectures');
  assert(lstatSync(join(dir, 'release-notes.md')).isFile(), 'Release notes must be a regular file');
  assert.equal(readFileSync(join(dir, 'release-notes.md'), 'utf8'), releaseDocument(sourceNotes.notes), 'Publication notes differ from source changelog');
  assert.equal(manifest.bundle_id, config.identifier, 'Bundle identity mismatch');
  assert.equal(manifest.archive, names[1], 'Unexpected archive');
  assert.equal(manifest.sha256, digest(files.get(names[1])), 'Archive hash mismatch');
  assert.equal(manifest.size, files.get(names[1]).length, 'Archive size mismatch');
  assert.equal(files.get('SHA256SUMS').toString(), `${digest(files.get(names[0]))}  ${names[0]}\n${manifest.sha256}  ${names[1]}\n`, 'Asset checksums mismatch');
  const signature = files.get('manifest.sig').toString().trim();
  assert.match(signature, /^[A-Za-z0-9+/]{86}==$/, 'Invalid Ed25519 signature encoding');
  const keys = readFileSync(join(root, 'src-tauri/release-public-key.hex'), 'utf8').split('\n').map(s => s.replace(/#.*/, '').trim()).filter(Boolean);
  assert(keys.some(hex => /^[0-9a-f]{64}$/i.test(hex) && verify(null, files.get('manifest.json'), createPublicKey({ key: Buffer.from(`302a300506032b6570032100${hex}`, 'hex'), format: 'der', type: 'spki' }), Buffer.from(signature, 'base64'))), 'Manifest signature not trusted by this source');
  return files;
}
