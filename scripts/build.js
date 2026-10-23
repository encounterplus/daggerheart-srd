#!/usr/bin/env node
//
// Build the module archive from the files currently on disk.
//
// Usage:
//   npm run build                                        # -> <repo>/dist/daggerheart-srd.module
//   npm run build -- /tmp/builds/daggerheart-srd.module
//
// The default file name is "<id>.module", with the id taken from manifest.json,
// written to dist/ in the repo root. An explicit output path is taken verbatim;
// relative paths resolve against the directory you ran npm from, not the repo root.
//
// The archive holds module.json, its banner and image, and one collection file per folder
// listed in COLLECTIONS or PAGE_COLLECTIONS:
//   COLLECTIONS       <folder>.json is a JSON array of every <folder>/*.json
//                     entity, in file-name order.
//   PAGE_COLLECTIONS  <folder>.json is a JSON array of every <folder>/*.md page:
//                     its YAML front matter plus the Markdown body as "content",
//                     in rank order.
// Nothing else from the repo is packed, so new folders (images, drafts) stay
// out until added to a list.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import YAML from "yaml";

// Entity folders concatenated into collections, one <folder>.json each.
const COLLECTIONS = [
  "adversaries",
  "ancestries",
  "armor",
  "beastforms",
  "classes",
  "communities",
  "consumables",
  "domain-cards",
  "environments",
  "items",
  "rules",
  "subclasses",
  "tables",
  "transformations",
  "weapons",
];

// Markdown page folders turned into collections, one <folder>.json each.
const PAGE_COLLECTIONS = ["pages"];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(`${path.relative(ROOT, file)}: ${e.message}`);
  }
}

// Files in a folder with the given extension, in plain code-point order so the
// result does not depend on the locale.
function listFiles(dir, ext) {
  if (!fs.existsSync(path.join(ROOT, dir))) return [];
  return fs
    .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(ext))
    .map((entry) => path.join(ROOT, dir, entry.name))
    .sort();
}

// One page: its front matter fields, with the Markdown body as "content" placed
// just before "sources" (or last, if there is no "sources").
function readPage(file) {
  const name = path.relative(ROOT, file);
  const lines = fs.readFileSync(file, "utf8").split("\n");

  if (lines[0].trimEnd() !== "---") fail(`${name}: missing YAML front matter`);
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
  if (end === -1) fail(`${name}: front matter is not closed with ---`);

  let header;
  try {
    header = YAML.parse(lines.slice(1, end).join("\n")) ?? {};
  } catch (e) {
    fail(`${name}: invalid front matter: ${e.message}`);
  }
  if (typeof header !== "object" || Array.isArray(header)) {
    fail(`${name}: front matter must be a mapping`);
  }
  for (const key of ["id", "name"]) {
    if (!header[key]) fail(`${name}: front matter has no '${key}'`);
  }

  const content = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "")
    .trimEnd();

  const page = {};
  for (const [key, value] of Object.entries(header)) {
    if (key === "sources") page.content = content;
    page[key] = value;
  }
  if (!("content" in page)) page.content = content;
  return page;
}

// Resolve the output against the directory npm was run from.
const callerDir = process.env.INIT_CWD ?? process.cwd();
const outputArg = process.argv[2];

if (outputArg === "-h" || outputArg === "--help") {
  fail("usage: npm run build [-- <output-file>]");
}

const manifest = readJson(path.join(ROOT, "manifest.json"));
const moduleJson = readJson(path.join(ROOT, "module.json"));
const moduleId = manifest.id;
const version = manifest.version;
const output = outputArg
  ? path.resolve(callerDir, outputArg)
  : path.join(DIST, `${moduleId}.module`);

// manifest.json and module.json must describe the same release.
const errors = [];
if (moduleJson.id !== moduleId) {
  errors.push(`id mismatch: manifest.json is '${moduleId}', module.json is '${moduleJson.id}'`);
}
if (moduleJson.version !== version) {
  errors.push(`version mismatch: manifest.json is '${version}', module.json is '${moduleJson.version}'`);
}
const expectedDownloadSuffix = `/releases/download/${version}/${moduleId}.module`;
if (!String(manifest.download).endsWith(expectedDownloadSuffix)) {
  errors.push(`manifest.json download is '${manifest.download}', expected it to end with '${expectedDownloadSuffix}'`);
}
if (errors.length) fail(errors.join("\n"));

// Image files module.json refers to, packed alongside it.
const images = ["banner", "image"].map((key) => moduleJson[key]).filter(Boolean);
for (const key of ["banner", "image"]) {
  const file = moduleJson[key];
  if (file && !fs.existsSync(path.join(ROOT, file))) fail(`module.json ${key} '${file}' not found`);
}

// Flag content folders that are not listed, so they are not dropped silently.
const listed = new Set([...COLLECTIONS, ...PAGE_COLLECTIONS]);
for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
  const dir = entry.name;
  if (!entry.isDirectory() || dir.startsWith(".") || dir === "node_modules" || listed.has(dir)) continue;
  if (listFiles(dir, ".json").length || listFiles(dir, ".md").length) {
    console.warn(`warning: ${dir}/ has JSON or Markdown files but is not in a collection list, skipping`);
  }
}

const zip = new JSZip();
const report = (name, count) => console.log(`  ${name.padEnd(16)} ${String(count).padStart(4)}`);

console.log(`${moduleId} ${version}`);

for (const name of COLLECTIONS) {
  const files = listFiles(name, ".json");
  if (!files.length) fail(`collection '${name}' has no JSON files in ${name}/`);
  zip.file(`${name}.json`, JSON.stringify(files.map(readJson), null, 2) + "\n");
  report(name, files.length);
}

for (const name of PAGE_COLLECTIONS) {
  const files = listFiles(name, ".md");
  if (!files.length) fail(`page collection '${name}' has no Markdown files in ${name}/`);
  // Array sort is stable, so pages with the same rank keep file-name order.
  const pages = files.map(readPage).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  zip.file(`${name}.json`, JSON.stringify(pages, null, 2) + "\n");
  report(name, files.length);
}

zip.file("module.json", fs.readFileSync(path.join(ROOT, "module.json")));
for (const file of images) zip.file(file, fs.readFileSync(path.join(ROOT, file)));

const archive = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
});

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, archive);

const fileCount = Object.values(zip.files).filter((f) => !f.dir).length;
console.log(`  ${fileCount} files, ${(archive.length / 1024).toFixed(0)}K ${output}`);
