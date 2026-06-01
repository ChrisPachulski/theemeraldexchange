// prepare hook for @theemeraldexchange/emerald-contracts-napi
//
// Goal: build the NAPI addon when a Rust toolchain is available, but never
// fail `npm install` on a contributor machine that lacks one. The production
// image stages a prebuilt .node from the dedicated Rust builder stage (see the
// repo-root Dockerfile), so prod consumers never hit this path.
//
// Behaviour:
//   1. If a prebuilt *.node already exists in this package, do nothing.
//   2. Otherwise attempt `napi build`; if the toolchain is missing or the build
//      fails, warn and exit 0 (non-fatal) instead of breaking the install.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const hasPrebuilt = readdirSync(pkgDir).some((f) => f.endsWith(".node"));
if (hasPrebuilt) {
  console.log("[emerald-contracts-napi] prebuilt .node present — skipping build.");
  process.exit(0);
}

const result = spawnSync(
  "napi",
  ["build", "--platform", "--release"],
  { cwd: pkgDir, stdio: "inherit", shell: true },
);

if (result.status !== 0) {
  console.warn(
    "[emerald-contracts-napi] napi build unavailable or failed — skipping. " +
      "Install a Rust toolchain and run `npm run build` here to produce the .node, " +
      "or rely on the prebuilt artifact staged by the Docker rust-builder stage.",
  );
}

// Always succeed so a missing Rust toolchain never breaks `npm install`.
process.exit(0);
