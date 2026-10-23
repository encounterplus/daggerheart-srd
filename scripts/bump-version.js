#!/usr/bin/env node
//
// Bump the module version in manifest.json and module.json, and keep the
// release download URL in manifest.json in sync with it.
//
// Usage:
//   npm run bump -- 1.0.1            # edit files only
//   npm run bump -- 1.0.1 --commit   # + git commit
//   npm run bump -- 1.0.1 --tag      # + git commit + annotated tag
//
// Then push the tag:
//   git push origin main && git push origin 1.0.1

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [version, mode = ""] = process.argv.slice(2);

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  fail("usage: npm run bump -- <major.minor.patch> [--commit|--tag]");
}
if (!["", "--commit", "--tag"].includes(mode)) fail(`unknown option: ${mode}`);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const manifest = readJson("manifest.json");
const moduleId = manifest.id;
const oldVersion = manifest.version;
const oldDownload = String(manifest.download);

// module.json has no repository field, so take the repo URL from the current
// download URL (<repo>/releases/download/<version>/<id>.module).
const marker = oldDownload.indexOf("/releases/download/");
if (marker === -1) fail(`cannot find the repo URL in manifest.json download '${oldDownload}'`);
const download = `${oldDownload.slice(0, marker)}/releases/download/${version}/${moduleId}.module`;

// Targeted in-place edits: keep each file's existing hand-written formatting
// instead of reserialising it.
function setField(file, key, value) {
  const text = fs.readFileSync(file, "utf8");
  const pattern = new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`);
  fs.writeFileSync(file, text.replace(pattern, (_, open, close) => `${open}${value}${close}`));
}

setField("manifest.json", "version", version);
setField("module.json", "version", version);
setField("manifest.json", "download", download);

// Re-read and validate exactly what scripts/build.js checks.
if (readJson("manifest.json").version !== version) fail("manifest.json version not updated");
if (readJson("module.json").version !== version) fail("module.json version not updated");
if (readJson("manifest.json").download !== download) fail("manifest.json download not updated");

console.log(`${oldVersion} -> ${version}`);
console.log("  manifest.json: version, download");
console.log("  module.json:   version");
console.log(`  download:      ${download}`);

const git = (...args) => execFileSync("git", args, { stdio: "inherit" });

if (mode === "--commit" || mode === "--tag") {
  git("add", "manifest.json", "module.json");
  git("commit", "-m", `Bump version to ${version}`);
}

if (mode === "--tag") {
  git("tag", "-a", version, "-m", version);
  console.log(`\nNext: git push origin HEAD && git push origin ${version}`);
} else if (mode === "") {
  console.log(`\nNext: review, commit, then tag ${version} and push.`);
}
