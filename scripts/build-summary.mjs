import { readdir, stat, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
const rows = [];
async function walk(dir) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name), info = await stat(path);
    if (info.isDirectory()) await walk(path);
    else rows.push({ path, bytes: info.size });
  }
}
await walk("ui/dist");
rows.sort((a, b) => b.bytes - a.bytes);
await writeFile("target/native-smoke/frontend-size.json", JSON.stringify(rows, null, 2) + "\n");
const summary = `### Production frontend\n\n${rows.length} files; ${rows.reduce((n, r) => n + r.bytes, 0)} uncompressed bytes.\n\n| File | Bytes |\n|---|---:|\n${rows.slice(0, 15).map(r => `| ${r.path} | ${r.bytes} |`).join("\n")}\n`;
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
