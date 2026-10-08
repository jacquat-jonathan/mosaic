// One-time release trust bootstrap. Never prints the private key or embeds it in the app.
import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const existing = process.argv[2];
const privateKey = existing ? createPrivateKey(readFileSync(existing)) : generateKeyPairSync("ed25519").privateKey;
const publicKey = createPublicKey(privateKey);
const secret = privateKey.export({ type: "pkcs8", format: "pem" });
const path = existing ?? join(mkdtempSync(join(tmpdir(), "mosaic-release-key-")), "private.pem");
if (!existing) writeFileSync(path, secret, { mode: 0o600 });
console.log(JSON.stringify({ publicKey: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex"), localSigningKey: path }));
try {
  execFileSync("gh", ["secret", "set", "MOSAIC_RELEASE_PRIVATE_KEY", "--repo", "jacquat-jonathan/mosaic"], { input: secret, stdio: ["pipe", "pipe", "pipe"] });
  console.log("GitHub release secret configured.");
} catch (e) {
  console.error("GitHub secret setup failed. The protected local signing key remains available. Add MOSAIC_RELEASE_PRIVATE_KEY in repository Settings > Secrets and variables > Actions.");
  console.error(e.stderr?.toString() ?? e.message); process.exitCode = 1;
}
