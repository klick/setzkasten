/* eslint-disable no-console */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const rootDir = process.cwd();
const cliDir = path.join(rootDir, "packages", "cli");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.captureOutput ? "pipe" : "inherit",
  });

  if (result.status !== 0) {
    if (options.captureOutput) {
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }

      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
    }

    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }

  return result;
}

function parsePackJson(rawStdout) {
  const text = rawStdout.trim();
  const firstBracket = text.indexOf("[");

  if (firstBracket === -1) {
    throw new Error("Could not parse npm pack output as JSON.");
  }

  const jsonSlice = text.slice(firstBracket);
  return JSON.parse(jsonSlice);
}

function ensureFiles(packInfo) {
  const fileEntries = Array.isArray(packInfo.files) ? packInfo.files : [];
  const paths = new Set(fileEntries.map((entry) => entry.path));

  const requiredFiles = [
    "LICENSE",
    "README.md",
    "package.json",
    "src/index.js",
    "src/lib/core.js",
    "src/lib/events.js",
    "src/lib/manifest-lib.js",
    "src/lib/policy.js",
    "src/lib/quote.js",
    "src/lib/scanner.js",
  ];

  const forbiddenPatterns = [
    /^AGENTS\.md$/,
    /^.*\/AGENTS\.md$/,
    /^__meta\//,
    /^test\//,
    /^src\/.*\.test\.js$/,
  ];

  const missing = requiredFiles.filter((filePath) => !paths.has(filePath));

  if (missing.length > 0) {
    throw new Error(`Pack is missing required files: ${missing.join(", ")}`);
  }

  const forbidden = Array.from(paths).filter((filePath) => {
    return forbiddenPatterns.some((pattern) => pattern.test(filePath));
  });

  if (forbidden.length > 0) {
    throw new Error(`Pack contains forbidden files: ${forbidden.join(", ")}`);
  }

  console.log(`Pack file count: ${paths.size}`);
  console.log(`Pack size: ${packInfo.size} bytes`);
}

function main() {
  if (!fs.existsSync(path.join(cliDir, "package.json"))) {
    throw new Error("Could not find packages/cli/package.json");
  }

  console.log("1) Running build/lint/test gates...");
  run("npm", ["run", "build"]);
  run("npm", ["run", "lint"]);
  run("npm", ["run", "test"]);

  console.log("2) Running npm pack dry-run for @setzkasten/cli...");
  const cacheDir = path.join(os.tmpdir(), "npm-cache-setzkasten");
  fs.mkdirSync(cacheDir, { recursive: true });

  const packResult = run("npm", ["pack", "--dry-run", "--json"], {
    cwd: cliDir,
    captureOutput: true,
    env: {
      ...process.env,
      npm_config_cache: cacheDir,
    },
  });

  const parsed = parsePackJson(packResult.stdout);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("npm pack returned empty output.");
  }

  const packInfo = parsed[0];
  ensureFiles(packInfo);

  console.log("3) Release check passed.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
