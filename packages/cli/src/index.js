#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { MANIFEST_FILENAME, parseListFlag, slugifyId } from "./lib/core.js";
import { appendProjectEvent } from "./lib/events.js";
import {
  addFontToManifest,
  createManifest,
  getManifestProjectId,
  loadManifest,
  removeFontFromManifest,
  saveManifest,
} from "./lib/manifest-lib.js";
import { evaluatePolicy } from "./lib/policy.js";
import { generateQuote } from "./lib/quote.js";
import { applyScanResultToManifest, scanProject } from "./lib/scanner.js";

function printHelp() {
  const helpText = `Setzkasten CLI (V1)

Usage:
  setzkasten <command> [options]

Commands:
  init      Create ${MANIFEST_FILENAME} and .setzkasten/events.log
  add       Add font entry to manifest
  remove    Remove font entry from manifest
  scan      Scan local repository usage and optionally discover font files
  policy    Evaluate policy decision (allow|warn|escalate)
  quote     Generate deterministic quote from license schema data
  migrate   Generate migration stub plan

Common options:
  --manifest <path>   Explicit path to ${MANIFEST_FILENAME}
Scan options:
  --path <dir>                 Directory to scan (default: project root)
  --discover                   Discover existing font files (woff2/woff/ttf/otf/otc)
  --max-discovered-files <n>   Max discovered files in output (default: 200)

Examples:
  setzkasten init --name "Acme Project"
  setzkasten add --font-id inter --family "Inter" --source oss
  setzkasten scan --path . --discover
  setzkasten policy --fail-on escalate
`;

  process.stdout.write(`${helpText}\n`);
}

function parseInput(argv) {
  if (argv.length === 0) {
    return {
      command: null,
      flags: {},
      positionals: [],
    };
  }

  const [command, ...rest] = argv;
  const flags = {};
  const positionals = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const normalized = token.slice(2);

    if (normalized.length === 0) {
      continue;
    }

    if (normalized.includes("=")) {
      const [rawKey, rawValue] = normalized.split(/=(.*)/, 2);
      addFlag(flags, rawKey, rawValue.length > 0 ? rawValue : "true");
      continue;
    }

    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      addFlag(flags, normalized, next);
      index += 1;
      continue;
    }

    addFlag(flags, normalized, true);
  }

  return {
    command,
    flags,
    positionals,
  };
}

function addFlag(flags, key, value) {
  const existing = flags[key];

  if (existing === undefined) {
    flags[key] = value;
    return;
  }

  if (Array.isArray(existing)) {
    existing.push(String(value));
    flags[key] = existing;
    return;
  }

  flags[key] = [String(existing), String(value)];
}

function getStringFlag(flags, key) {
  const value = flags[key];

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value.length > 0) {
    return value[value.length - 1];
  }

  return undefined;
}

function getBooleanFlag(flags, key) {
  const value = flags[key];

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value === "true";
  }

  if (Array.isArray(value) && value.length > 0) {
    return value[value.length - 1] === "true";
  }

  return false;
}

function getListFlag(flags, key) {
  const value = flags[key];

  if (value === undefined) {
    return [];
  }

  return parseListFlag(value);
}

function requireStringFlag(flags, key) {
  const value = getStringFlag(flags, key);
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required option --${key}`);
  }

  return value.trim();
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveManifestPathFromFlag(cwd, flags) {
  const value = getStringFlag(flags, "manifest");
  return value ? path.resolve(cwd, value) : undefined;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function handleInit(cwd, flags) {
  const force = getBooleanFlag(flags, "force");
  const providedManifestPath = resolveManifestPathFromFlag(cwd, flags);
  const manifestPath = providedManifestPath ?? path.join(cwd, MANIFEST_FILENAME);

  if (!force && (await exists(manifestPath))) {
    throw new Error(
      `${MANIFEST_FILENAME} already exists at ${manifestPath}. Use --force to overwrite.`,
    );
  }

  const projectName = getStringFlag(flags, "name") ?? path.basename(cwd);
  const projectId = getStringFlag(flags, "project-id") ?? slugifyId(projectName);
  const licenseeName = getStringFlag(flags, "licensee-name") ?? projectName;

  const manifest = createManifest({
    projectName,
    projectId,
    projectRepo: getStringFlag(flags, "repo"),
    projectDomains: getListFlag(flags, "domain"),
    licenseeId: getStringFlag(flags, "licensee-id"),
    licenseeType: getStringFlag(flags, "licensee-type") ?? "organization",
    licenseeLegalName: licenseeName,
    licenseeCountry: getStringFlag(flags, "licensee-country"),
    licenseeVatId: getStringFlag(flags, "licensee-vat-id"),
    licenseeContactEmail: getStringFlag(flags, "licensee-email"),
  });

  await saveManifest(manifestPath, manifest);

  const projectRoot = path.dirname(manifestPath);
  await appendProjectEvent({
    projectRoot,
    projectId: getManifestProjectId(manifest),
    eventType: "manifest.created",
    payload: {
      manifest_path: manifestPath,
    },
  });

  printJson({
    ok: true,
    command: "init",
    manifest_path: manifestPath,
    project_id: projectId,
  });

  return 0;
}

async function handleAdd(cwd, flags) {
  const manifestPath = resolveManifestPathFromFlag(cwd, flags);
  const { manifest, manifestPath: resolvedManifestPath, projectRoot } = await loadManifest({
    cwd,
    manifestPath,
  });

  const fontId = requireStringFlag(flags, "font-id");
  const familyName = requireStringFlag(flags, "family");
  const sourceType = requireStringFlag(flags, "source");

  if (sourceType !== "oss" && sourceType !== "byo") {
    throw new Error("--source must be either 'oss' or 'byo'.");
  }

  const licenseInstanceIds = getListFlag(flags, "license-instance-id");
  const activeLicenseInstanceId = getStringFlag(flags, "active-license-instance-id");

  if (activeLicenseInstanceId && !licenseInstanceIds.includes(activeLicenseInstanceId)) {
    licenseInstanceIds.push(activeLicenseInstanceId);
  }

  const updatedManifest = addFontToManifest(manifest, {
    font_id: fontId,
    family_name: familyName,
    source: {
      type: sourceType,
      name: getStringFlag(flags, "source-name"),
      uri: getStringFlag(flags, "source-uri"),
      notes: getStringFlag(flags, "notes"),
    },
    active_license_instance_id: activeLicenseInstanceId,
    license_instance_ids: licenseInstanceIds,
  });

  await saveManifest(resolvedManifestPath, updatedManifest);

  await appendProjectEvent({
    projectRoot,
    projectId: getManifestProjectId(updatedManifest),
    eventType: "manifest.font_added",
    payload: {
      font_id: fontId,
      family_name: familyName,
      source_type: sourceType,
    },
  });

  printJson({
    ok: true,
    command: "add",
    manifest_path: resolvedManifestPath,
    font_id: fontId,
  });

  return 0;
}

async function handleRemove(cwd, flags) {
  const manifestPath = resolveManifestPathFromFlag(cwd, flags);
  const { manifest, manifestPath: resolvedManifestPath, projectRoot } = await loadManifest({
    cwd,
    manifestPath,
  });

  const fontId = requireStringFlag(flags, "font-id");
  const result = removeFontFromManifest(manifest, fontId);

  if (!result.removed) {
    throw new Error(`Font '${fontId}' not found in manifest.`);
  }

  await saveManifest(resolvedManifestPath, result.manifest);

  await appendProjectEvent({
    projectRoot,
    projectId: getManifestProjectId(result.manifest),
    eventType: "manifest.font_removed",
    payload: {
      font_id: fontId,
    },
  });

  printJson({
    ok: true,
    command: "remove",
    manifest_path: resolvedManifestPath,
    font_id: fontId,
  });

  return 0;
}

async function handleScan(cwd, flags) {
  const manifestPath = resolveManifestPathFromFlag(cwd, flags);
  const { manifest, manifestPath: resolvedManifestPath, projectRoot } = await loadManifest({
    cwd,
    manifestPath,
  });

  const scanRoot = path.resolve(cwd, getStringFlag(flags, "path") ?? projectRoot);
  const maxMatchedPaths = Number(getStringFlag(flags, "max-matched-paths") ?? "30");
  const maxDiscoveredFiles = Number(getStringFlag(flags, "max-discovered-files") ?? "200");
  const discover = getBooleanFlag(flags, "discover");

  const scanResult = await scanProject({
    rootPath: scanRoot,
    manifest,
    maxMatchedPathsPerFont: Number.isFinite(maxMatchedPaths) ? maxMatchedPaths : 30,
    maxDiscoveredFiles: Number.isFinite(maxDiscoveredFiles) ? maxDiscoveredFiles : 200,
    discover,
  });

  const updatedManifest = applyScanResultToManifest(manifest, scanResult);
  await saveManifest(resolvedManifestPath, updatedManifest);

  await appendProjectEvent({
    projectRoot,
    projectId: getManifestProjectId(updatedManifest),
    eventType: "scan.completed",
    payload: {
      scanned_at: scanResult.scanned_at,
      scanned_files_count: scanResult.scanned_files_count,
      discovered_font_files_count: Array.isArray(scanResult.discovered_font_files)
        ? scanResult.discovered_font_files.length
        : 0,
      discover_enabled: discover,
      root_path: scanResult.root_path,
    },
  });

  printJson({
    ok: true,
    command: "scan",
    result: scanResult,
  });

  return 0;
}

async function handlePolicy(cwd, flags) {
  const manifestPath = resolveManifestPathFromFlag(cwd, flags);
  const { manifest, projectRoot } = await loadManifest({
    cwd,
    manifestPath,
  });

  const policy = evaluatePolicy(manifest);

  await appendProjectEvent({
    projectRoot,
    projectId: getManifestProjectId(manifest),
    eventType: policy.decision === "allow" ? "policy.ok" : "policy.warning_raised",
    payload: {
      decision: policy.decision,
      reasons_count: policy.reasons.length,
      evidence_required: policy.evidence_required,
    },
  });

  printJson(policy);

  const failOn = getStringFlag(flags, "fail-on") ?? "escalate";
  if (failOn === "warn") {
    return policy.decision === "allow" ? 0 : 2;
  }

  if (failOn === "escalate") {
    return policy.decision === "escalate" ? 2 : 0;
  }

  return 0;
}

async function handleQuote(cwd, flags) {
  const manifestPath = resolveManifestPathFromFlag(cwd, flags);
  const { manifest, projectRoot } = await loadManifest({
    cwd,
    manifestPath,
  });

  const quote = generateQuote(manifest);

  await appendProjectEvent({
    projectRoot,
    projectId: getManifestProjectId(manifest),
    eventType: "quote.generated",
    payload: {
      generated_at: quote.generated_at,
      totals: quote.totals,
      line_items_count: quote.line_items.length,
      skipped_count: quote.skipped.length,
      deterministic_hash: quote.deterministic_hash,
    },
  });

  printJson(quote);
  return 0;
}

async function handleMigrate(cwd, flags) {
  const manifestPath = resolveManifestPathFromFlag(cwd, flags);
  const { manifest, projectRoot } = await loadManifest({
    cwd,
    manifestPath,
  });

  const currentVersion =
    typeof manifest.manifest_version === "string" ? manifest.manifest_version : "unknown";

  const migrationPlan = {
    mode: "stub",
    from_manifest_version: currentVersion,
    to_manifest_version: "1.0.0",
    actions: [
      "Inspect schema differences",
      "Draft migration transformations",
      "Run dry-run migration validation",
    ],
  };

  await appendProjectEvent({
    projectRoot,
    projectId: getManifestProjectId(manifest),
    eventType: "migration.planned",
    payload: migrationPlan,
  });

  printJson({
    ok: true,
    command: "migrate",
    migration: migrationPlan,
  });

  return 0;
}

export async function runCli(argv = process.argv.slice(2), cwd = process.cwd()) {
  const parsed = parseInput(argv);

  if (!parsed.command || parsed.command === "help" || parsed.command === "--help") {
    printHelp();
    return 0;
  }

  switch (parsed.command) {
    case "init":
      return handleInit(cwd, parsed.flags);
    case "add":
      return handleAdd(cwd, parsed.flags);
    case "remove":
      return handleRemove(cwd, parsed.flags);
    case "scan":
      return handleScan(cwd, parsed.flags);
    case "policy":
      return handlePolicy(cwd, parsed.flags);
    case "quote":
      return handleQuote(cwd, parsed.flags);
    case "migrate":
      return handleMigrate(cwd, parsed.flags);
    default:
      throw new Error(`Unknown command '${parsed.command}'. Run 'setzkasten --help'.`);
  }
}

function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  try {
    const entryResolvedPath = realpathSync(entry);
    const currentFileResolvedPath = realpathSync(fileURLToPath(importMetaUrl));
    return entryResolvedPath === currentFileResolvedPath;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  runCli()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
}
