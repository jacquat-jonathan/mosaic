// One parser shared by preparation, preflight and packaging. Never silently drop prose.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export function releaseNotes(text, version, { allowEmpty = false } = {}) {
  const heading = version === 'Unreleased' ? /^## Unreleased\s*$/ : new RegExp(`^## ${version.replaceAll('.', '\\.')} — (\\d{4}-\\d{2}-\\d{2})\\s*$`);
  const lines = text.split(/\r?\n/);
  const prefix = new RegExp(`^## ${version.replaceAll('.', '\\.')}($|\\s)`);
  const starts = lines.flatMap((line, i) => prefix.test(line) ? [i] : []);
  assert.equal(starts.length, 1, `Expected one ${version} changelog heading`);
  const start = starts[0], notes = [];
  assert(heading.test(lines[start]), `Malformed ${version} changelog heading`);
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    if (!line.trim()) continue;
    if (line.startsWith('- ')) { notes.push(line.slice(2)); current = notes.length - 1; }
    else if (/^\s+\S/.test(line) && current !== null) notes[current] += `\n${line}`;
    else throw new Error(`Unsupported changelog prose under ${version}; use bullets with indented continuations`);
  }
  assert(allowEmpty || notes.length, `Empty ${version} release notes`);
  const date = lines[start].match(heading)?.[1];
  if (date) assert.equal(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10), date, 'Invalid release date');
  return { notes, date };
}
export const notesMarkdown = notes => notes.map(note => `- ${note}`).join('\n');
export const releaseDocument = notes => `${notesMarkdown(notes)}\n\nDownload the universal DMG, drag Mosaic to Applications, and launch it there. macOS 12+; Intel and Apple Silicon. Ad-hoc signed, not Apple-notarized. See README for the app-specific first-launch approval.\n`;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(notesMarkdown(releaseNotes(readFileSync(process.argv[2], 'utf8'), process.argv[3]).notes));
