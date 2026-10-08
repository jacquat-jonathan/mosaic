// Packages an already-built universal app. Private keys are generated artifacts, never committed.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, symlinkSync, readdirSync, lstatSync, realpathSync, createReadStream } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json")));
const version = config.version;
assert.match(version, /^\d+\.\d+\.\d+$/);
const bundle = resolve(process.argv[2] ?? join(root, "target/universal-apple-darwin/release/bundle/macos/Mosaic.app"));
const pem = process.env.MOSAIC_RELEASE_PRIVATE_KEY ?? (process.env.MOSAIC_RELEASE_KEY_FILE ? readFileSync(process.env.MOSAIC_RELEASE_KEY_FILE) : null);
assert(pem, "A release signing key is required; unsigned update assets must not be published");
const privateKey = createPrivateKey(pem);
const publicKey = createPublicKey(privateKey);
assert.equal(publicKey.export({type:"spki",format:"der"}).subarray(-32).toString("hex"), readFileSync(join(root,"src-tauri/release-public-key.hex"),"utf8").trim(), "The release key must match the app's embedded trust root");
const run = (cmd, args) => execFileSync(cmd, args, {encoding:"utf8", stdio:["ignore","pipe","pipe"]}).trim();
const plist = field => run("/usr/bin/plutil", ["-extract", field, "raw", "-o", "-", join(bundle,"Contents/Info.plist")]);
assert.equal(plist("CFBundleIdentifier"), config.identifier);
assert.equal(plist("CFBundleShortVersionString"), version);
assert.equal(plist("LSMinimumSystemVersion"), "12.0");
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
for (const binary of ["mosaic-app", "mosaic"]) {
  const architectures = run("/usr/bin/lipo",["-archs",join(bundle,"Contents/MacOS",binary)]);
  assert(architectures.includes("arm64") && architectures.includes("x86_64"), "Both app and CLI must be universal");
}
assert.equal(run(join(bundle,"Contents/MacOS/mosaic"),["--version"]),`mosaic ${version}`,"Bundled CLI must match the app version");
// Refuse package links that escape its app, even when codesign accepts them.
function inspect(dir) { for(const name of readdirSync(dir)) { const path=join(dir,name), stat=lstatSync(path); if(stat.isSymbolicLink()) assert(realpathSync(path).startsWith(bundle+"/"), `Escaping package symlink: ${path}`); else if(stat.isDirectory()) inspect(path); } }
inspect(bundle);
const changelog = readFileSync(join(root,"CHANGELOG.md"),"utf8");
const section = changelog.split(`## ${version} — `)[1];
assert(section, "Release version needs its CHANGELOG heading before packaging");
const date = section.split("\n")[0].trim();
const notes = section.split(/^## /m)[0].split("\n").filter(line=>line.startsWith("- ")).map(line=>line.slice(2));
assert(notes.length, "Release notes cannot be empty");
const releases = join(root,"target/releases"); mkdirSync(releases,{recursive:true});
const out = join(releases,`v${version}`); mkdirSync(out); // Refuse to overwrite a previous package.
const stage = mkdtempSync(join(tmpdir(),"mosaic-dmg-"));
run("/usr/bin/ditto",[bundle,join(stage,"Mosaic.app")]);
symlinkSync("/Applications",join(stage,"Applications"));
writeFileSync(join(stage,"Read me.txt"),"Drag Mosaic.app to Applications, then open it there.\nMosaic is ad-hoc signed, not notarized by Apple. If macOS cannot verify the developer, use System Settings > Privacy & Security > Open Anyway for Mosaic. Never override a malware warning or disable Gatekeeper.\nNo build tools required. Choose your notes folder after launch. AI features are optional.\n");
const dmg = `Mosaic-${version}-universal.dmg`, archive = `Mosaic-${version}-universal.tar.gz`;
run("/usr/bin/hdiutil",["create","-volname",`Mosaic ${version}`,"-srcfolder",stage,"-format","UDZO",join(out,dmg)]);
execFileSync("/usr/bin/tar",["-czf",join(out,archive),"-C",dirname(bundle),"Mosaic.app"],{env:{...process.env,COPYFILE_DISABLE:"1"},stdio:["ignore","pipe","pipe"]});
const sha = async path => { const hash=createHash("sha256"); for await(const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); };
const archiveHash = await sha(join(out,archive));
const { statSync } = await import("node:fs");
const manifest = Buffer.from(JSON.stringify({version,bundle_id:config.identifier,minimum_macos:"12.0",architectures:["arm64","x86_64"],archive,sha256:archiveHash,size:statSync(join(out,archive)).size,date,notes})+"\n");
const signature = sign(null,manifest,privateKey); assert(verify(null,manifest,publicKey,signature));
writeFileSync(join(out,"manifest.json"),manifest);
writeFileSync(join(out,"manifest.sig"),signature.toString("base64"));
writeFileSync(join(out,"SHA256SUMS"),`${await sha(join(out,dmg))}  ${dmg}\n${archiveHash}  ${archive}\n`);
writeFileSync(join(out,"release-notes.md"),notes.map(note=>`- ${note}`).join("\n")+"\n\nDownload the universal DMG, drag Mosaic to Applications, and launch it there. macOS 12+; Intel and Apple Silicon. Ad-hoc signed, not Apple-notarized. See README for the app-specific first-launch approval.\n");
console.log(`Packaged signed release assets: ${out}`);
