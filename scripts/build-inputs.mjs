// Build diagnostics, not a signed provenance attestation. Never collect environment variables.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, createReadStream, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = async path => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
export async function collectInputs(root, artifacts, run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim()) {
  const files = [];
  async function visit(dir, relative = '') {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), rel = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Artifact symlink refused: ${rel}`);
      if (stat.isDirectory()) await visit(path, rel);
      else if (stat.isFile()) files.push({ path: rel, bytes: stat.size, sha256: await digest(path) });
      else throw new Error(`Unsupported artifact: ${rel}`);
    }
  }
  await visit(artifacts);
  if (!files.length) throw new Error('No artifacts to record');
  return {
    schema_version: 1,
    source: { commit: run('git', ['rev-parse', 'HEAD']), dirty: run('git', ['status', '--porcelain', '--untracked-files=no']) !== '' },
    tools: { rustc: run('rustc', ['-vV']), cargo: run('cargo', ['--version']), node: run('node', ['--version']), pnpm: run('pnpm', ['--version']) },
    platform: { os: process.platform, arch: process.arch },
    locks: Object.fromEntries(await Promise.all(['Cargo.lock', 'pnpm-lock.yaml'].map(async name => [name, await digest(join(root, name))]))),
    pins: { rust: readFileSync(join(root, 'rust-toolchain.toml'), 'utf8').trim(), node: readFileSync(join(root, '.nvmrc'), 'utf8').trim(), packageManager: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager },
    artifacts: files,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [artifacts, output] = process.argv.slice(2);
  if (!artifacts || !output) throw new Error('Usage: node scripts/build-inputs.mjs <artifact-directory> <output.json>');
  if (resolve(output).startsWith(`${resolve(artifacts)}/`)) throw new Error('Keep the input record outside the artifact directory');
  const record = await collectInputs(process.cwd(), resolve(artifacts));
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
  const summary = `### Build inputs\n\nSource: \`${record.source.commit}\` (dirty: ${record.source.dirty})\n\n${Object.entries(record.tools).map(([name, version]) => `- ${name}: ${version.split('\n')[0]}`).join('\n')}\n\n| Artifact | Bytes | SHA-256 |\n| --- | ---: | --- |\n${record.artifacts.map(file => `| ${file.path} | ${file.bytes} | \`${file.sha256}\` |`).join('\n')}\n\nFull record: build-inputs workflow artifact. This is diagnostic metadata, not signed provenance.\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
}
