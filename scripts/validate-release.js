"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const versions = JSON.parse(readFileSync(join(root, "versions.json"), "utf8"));
const releaseVersion = process.argv[2] ?? manifest.version;
const failures = [];

function requireCondition(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

requireCondition(/^\d+\.\d+\.\d+$/.test(releaseVersion), "Release tag must use x.y.z.");
requireCondition(manifest.version === releaseVersion, "Release tag must match manifest.json.");
requireCondition(packageJson.version === releaseVersion, "package.json must match manifest.json.");
requireCondition(
  versions[releaseVersion] === manifest.minAppVersion,
  "versions.json must map the release to minAppVersion."
);
requireCondition(/^[a-z][a-z-]*[a-z]$/.test(manifest.id), "Plugin ID must use lowercase letters and hyphens.");
requireCondition(!manifest.id.includes("obsidian"), "Plugin ID must not contain obsidian.");
requireCondition(!manifest.id.endsWith("plugin"), "Plugin ID must not end with plugin.");
requireCondition(manifest.author !== "Local plugin", "Replace the placeholder author.");
requireCondition(manifest.description.length <= 250, "Description must not exceed 250 characters.");
requireCondition(manifest.description.endsWith("."), "Description must end with a period.");

for (const file of ["LICENSE", "README.md", "main.js", "manifest.json", "styles.css"]) {
  requireCondition(existsSync(join(root, file)), `Missing release file: ${file}`);
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
}
