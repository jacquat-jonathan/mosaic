// Signs a packaged release: checks the assets against manifest.json, then writes manifest.sig.
// Runs in the release workflow's protected `sign` job, which holds the signing key. So it uses
// Node's built-ins only and never runs anything the build produced: it only hashes and signs.
// Usage: MOSAIC_RELEASE_PRIVATE_KEY=… node scripts/sign-release.mjs [target/releases/vX.Y.Z]
//        (or MOSAIC_RELEASE_KEY_FILE=path/to/private.pem)
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = config.version;
const dir = resolve(process.argv[2] ?? join(root, `target/releases/v${version}`));
const pem =
  process.env.MOSAIC_RELEASE_PRIVATE_KEY ??
  (process.env.MOSAIC_RELEASE_KEY_FILE ? readFileSync(process.env.MOSAIC_RELEASE_KEY_FILE) : null);
assert(pem, "A release signing key is required; unsigned update assets must not be published");

// The keys the app trusts, one hex Ed25519 public key per line (see docs/PUBLISHING.md).
const trusted = readFileSync(join(root, "src-tauri/release-public-key.hex"), "utf8")
  .split("\n")
  .map((line) => line.replace(/#.*/, "").trim())
  .filter(Boolean);
const privateKey = createPrivateKey(pem);
const publicKey = createPublicKey(privateKey);
const publicHex = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
assert(trusted.includes(publicHex), "The signing key must be one the app trusts (src-tauri/release-public-key.hex)");
if (trusted.length < 2)
  console.warn("::warning::This release trusts a single key; add a standby key so it can be rotated (docs/PUBLISHING.md).");

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const bytes = readFileSync(join(dir, "manifest.json"));
const manifest = JSON.parse(bytes);
const archive = `Mosaic-${version}-universal.tar.gz`;
const dmg = `Mosaic-${version}-universal.dmg`;
assert.equal(manifest.version, version, "manifest version");
assert.equal(manifest.bundle_id, config.identifier, "manifest bundle id");
assert.equal(manifest.archive, archive, "manifest archive name");
assert.equal(manifest.sha256, sha(join(dir, archive)), "the archive doesn't match its manifest");
assert.equal(manifest.size, statSync(join(dir, archive)).size, "the archive size doesn't match its manifest");
assert.equal(
  readFileSync(join(dir, "SHA256SUMS"), "utf8"),
  `${sha(join(dir, dmg))}  ${dmg}\n${manifest.sha256}  ${archive}\n`,
  "SHA256SUMS doesn't match the assets",
);
assert(!existsSync(join(dir, "manifest.sig")), "manifest.sig already exists; refusing to re-sign");

const signature = sign(null, bytes, privateKey);
assert(verify(null, bytes, publicKey, signature));
writeFileSync(join(dir, "manifest.sig"), signature.toString("base64"));
console.log(`Signed ${version} with key ${publicHex.slice(0, 16)}…: ${join(dir, "manifest.sig")}`);
