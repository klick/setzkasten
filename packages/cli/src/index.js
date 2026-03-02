#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  EVENT_LOG_RELATIVE_PATH,
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  findUp,
  parseListFlag,
  sha256Hex,
  slugifyId,
} from "./lib/core.js";
import { appendProjectEvent } from "./lib/events.js";
import {
  addFontToManifest,
  createManifest,
  getManifestProjectId,
  loadManifest,
  removeFontFromManifest,
  saveManifest,
  upsertLicenseEvidence,
} from "./lib/manifest-lib.js";
import { POLICY_PRESETS, applyPolicyPreset, evaluatePolicy } from "./lib/policy.js";
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
  scan      Scan local repository usage and optionally discover font/license files
  import    Import manifest font entries from discovered repository font files
  doctor    Diagnose manifest and evidence readiness for CI usage
  evidence  Attach/update license evidence from local files
  exception Manage policy exceptions (add, list, remove)
  policy    Evaluate policy decision (allow|warn|escalate)
  quote     Generate deterministic quote from license schema data
  migrate   Plan/apply manifest migration with backup safety

Common options:
  --manifest <path>   Explicit path to ${MANIFEST_FILENAME}
Scan options:
  --path <dir>                 Directory to scan (default: project root)
  --discover                        Discover existing font files and font-adjacent license files
  --max-discovered-files <n>        Max discovered font files in output (default: 200)
  --max-discovered-license-files <n> Max discovered license files in output (default: 200)
  --format <json|sarif|junit>       Output format for scan results (default: json)
Import options:
  --path <dir>                 Directory to scan for import candidates (default: project root)
  --source <oss|byo>           Source type assigned to imported fonts (default: byo)
  --apply                      Apply candidate imports (default is dry-run)
Policy options:
  --format <json|sarif|junit>       Output format for policy results (default: json)
  --preset <strict|startup|enterprise> Apply opinionated policy profile
Exception options:
  setzkasten exception add --code <policy_code> [--font-id <font_id>] [--license-id <license_id>]
    [--reason <text>] [--expires-at <iso-date-time>] [--exception-id <id>]
  setzkasten exception list
  setzkasten exception remove --exception-id <id>
Evidence options:
  setzkasten evidence add --license-id <id> --file <path>
    [--type <type>] [--evidence-id <id>] [--document-name <name>]
    [--document-url <uri>] [--reference <id>] [--issuer <name>]
    [--purchased-at <iso-date-time>] [--notes <text>]
  setzkasten evidence suggest [--path <dir>] [--apply]
  setzkasten evidence verify [--strict]

Examples:
  setzkasten init --name "Acme Project"
  setzkasten import --path .
  setzkasten import --path . --apply
  setzkasten add --font-id inter --family "Inter" --source oss
  setzkasten scan --path . --discover
  setzkasten evidence suggest --path .
  setzkasten evidence verify --strict
  setzkasten evidence add --license-id lic_web_001 --file ./licenses/OFL.txt
  setzkasten exception add --code BYO_NO_EVIDENCE --font-id inter --reason "Temporary waiver"
  setzkasten policy presets
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

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value) {
  return typeof value === "string" ? value : null;
}

function asStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => typeof entry === "string");
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

function summarizeChecks(checks) {
  const counts = {
    pass: 0,
    warn: 0,
    error: 0,
    skip: 0,
  };

  for (const check of checks) {
    const status = typeof check.status === "string" ? check.status : "skip";
    if (status in counts) {
      counts[status] += 1;
    } else {
      counts.skip += 1;
    }
  }

  let overall = "pass";
  if (counts.error > 0) {
    overall = "error";
  } else if (counts.warn > 0) {
    overall = "warn";
  }

  return {
    overall,
    pass_count: counts.pass,
    warn_count: counts.warn,
    error_count: counts.error,
    skipped_count: counts.skip,
  };
}

function createDoctorCheck(input) {
  const check = {
    id: input.id,
    status: input.status,
    message: input.message,
  };

  if (input.fix) {
    check.fix = input.fix;
  }

  if (input.details !== undefined) {
    check.details = input.details;
  }

  return check;
}

function resolveUniqueFontId(baseId, reservedIds) {
  const normalizedBase = slugifyId(baseId || "font", "font");
  if (!reservedIds.has(normalizedBase)) {
    reservedIds.add(normalizedBase);
    return normalizedBase;
  }

  let index = 2;
  while (index < 10000) {
    const candidate = slugifyId(`${normalizedBase}-${index}`, "font");
    if (!reservedIds.has(candidate)) {
      reservedIds.add(candidate);
      return candidate;
    }
    index += 1;
  }

  throw new Error("Could not generate unique font_id for imported font candidate.");
}

function getOutputFormat(flags) {
  const format = (getStringFlag(flags, "format") ?? "json").toLowerCase();
  const supported = new Set(["json", "sarif", "junit"]);
  if (!supported.has(format)) {
    throw new Error("--format must be one of: json, sarif, junit");
  }
  return format;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function printText(value) {
  process.stdout.write(`${value}\n`);
}

function findingsToSarif(commandName, findings) {
  const rulesById = new Map();

  for (const finding of findings) {
    if (!rulesById.has(finding.rule_id)) {
      rulesById.set(finding.rule_id, {
        id: finding.rule_id,
        name: finding.rule_id,
        shortDescription: {
          text: finding.rule_id,
        },
      });
    }
  }

  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: `setzkasten/${commandName}`,
            rules: Array.from(rulesById.values()),
          },
        },
        results: findings.map((finding) => ({
          ruleId: finding.rule_id,
          level: finding.level,
          message: { text: finding.message },
          properties: finding.properties ?? {},
        })),
      },
    ],
  };
}

function findingsToJunit(suiteName, findings) {
  const testcaseXml = findings
    .map((finding, index) => {
      const caseName = `${finding.rule_id}-${index + 1}`;
      const message = xmlEscape(finding.message);
      const propertiesJson = xmlEscape(JSON.stringify(finding.properties ?? {}));

      if (finding.level === "error" || finding.level === "warning") {
        return `  <testcase classname="${xmlEscape(suiteName)}" name="${xmlEscape(caseName)}"><failure type="${xmlEscape(finding.level)}" message="${message}">${propertiesJson}</failure></testcase>`;
      }

      return `  <testcase classname="${xmlEscape(suiteName)}" name="${xmlEscape(caseName)}" />`;
    })
    .join("\n");

  const failures = findings.filter((finding) => finding.level === "error" || finding.level === "warning").length;
  const tests = findings.length > 0 ? findings.length : 1;

  if (findings.length === 0) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xmlEscape(
      suiteName,
    )}" tests="1" failures="0">\n  <testcase classname="${xmlEscape(
      suiteName,
    )}" name="no-findings" />\n</testsuite>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xmlEscape(
    suiteName,
  )}" tests="${tests}" failures="${failures}">\n${testcaseXml}\n</testsuite>`;
}

function policyToFindings(policy) {
  if (!Array.isArray(policy.reasons)) {
    return [];
  }

  return policy.reasons.map((reason) => {
    const severity = reason?.severity === "escalate" ? "error" : "warning";
    return {
      rule_id: reason?.code ?? "POLICY_REASON",
      level: severity,
      message: reason?.message ?? "Policy finding",
      properties: reason?.context ?? {},
    };
  });
}

function scanToFindings(scanResult) {
  const findings = [];
  const fontMatches = isObject(scanResult.font_matches) ? scanResult.font_matches : {};
  for (const [fontId, match] of Object.entries(fontMatches)) {
    if (!isObject(match)) {
      continue;
    }

    const matchCount = typeof match.match_count === "number" ? match.match_count : 0;
    findings.push({
      rule_id: matchCount > 0 ? "SCAN_FONT_USAGE_MATCH" : "SCAN_FONT_NO_USAGE_MATCH",
      level: matchCount > 0 ? "note" : "warning",
      message:
        matchCount > 0
          ? `Font '${fontId}' has ${matchCount} usage match(es).`
          : `Font '${fontId}' has no usage matches.`,
      properties: {
        font_id: fontId,
        match_count: matchCount,
      },
    });
  }

  const discoveredLicenses = Array.isArray(scanResult.discovered_license_files)
    ? scanResult.discovered_license_files
    : [];
  for (const entry of discoveredLicenses) {
    const detected = asString(entry.detected_license);
    findings.push({
      rule_id: detected ? "SCAN_LICENSE_DETECTED" : "SCAN_LICENSE_UNKNOWN",
      level: detected ? "note" : "warning",
      message: detected
        ? `Detected '${detected}' in '${entry.path}'.`
        : `Could not detect a known license in '${entry.path}'.`,
      properties: {
        path: entry.path,
        detected_license: detected,
      },
    });
  }

  return findings;
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
  const maxDiscoveredLicenseFiles = Number(getStringFlag(flags, "max-discovered-license-files") ?? "200");
  const discover = getBooleanFlag(flags, "discover");

  const scanResult = await scanProject({
    rootPath: scanRoot,
    manifest,
    maxMatchedPathsPerFont: Number.isFinite(maxMatchedPaths) ? maxMatchedPaths : 30,
    maxDiscoveredFiles: Number.isFinite(maxDiscoveredFiles) ? maxDiscoveredFiles : 200,
    maxDiscoveredLicenseFiles: Number.isFinite(maxDiscoveredLicenseFiles) ? maxDiscoveredLicenseFiles : 200,
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
      discovered_license_files_count: Array.isArray(scanResult.discovered_license_files)
        ? scanResult.discovered_license_files.length
        : 0,
      discover_enabled: discover,
      root_path: scanResult.root_path,
    },
  });

  const format = getOutputFormat(flags);
  if (format === "json") {
    printJson({
      ok: true,
      command: "scan",
      result: scanResult,
    });
  } else if (format === "sarif") {
    printJson(findingsToSarif("scan", scanToFindings(scanResult)));
  } else {
    printText(findingsToJunit("setzkasten.scan", scanToFindings(scanResult)));
  }

  return 0;
}

async function handleImport(cwd, flags) {
  const manifestPath = resolveManifestPathFromFlag(cwd, flags);
  const { manifest, manifestPath: resolvedManifestPath, projectRoot } = await loadManifest({
    cwd,
    manifestPath,
  });

  const scanRoot = path.resolve(cwd, getStringFlag(flags, "path") ?? projectRoot);
  const sourceType = getStringFlag(flags, "source") ?? "byo";
  const apply = getBooleanFlag(flags, "apply");
  const maxDiscoveredFilesInput = Number(getStringFlag(flags, "max-discovered-files") ?? "200");
  const maxDiscoveredFiles =
    Number.isFinite(maxDiscoveredFilesInput) && maxDiscoveredFilesInput > 0 ? maxDiscoveredFilesInput : 200;

  if (sourceType !== "oss" && sourceType !== "byo") {
    throw new Error("--source must be either 'oss' or 'byo'.");
  }

  const scanResult = await scanProject({
    rootPath: scanRoot,
    manifest,
    maxMatchedPathsPerFont: 0,
    maxDiscoveredFiles,
    maxDiscoveredLicenseFiles: 0,
    discover: true,
  });

  const discoveredFonts = Array.isArray(scanResult.discovered_font_files)
    ? scanResult.discovered_font_files
    : [];
  const existingFonts = Array.isArray(manifest.fonts) ? manifest.fonts : [];
  const existingFontIds = new Set(
    existingFonts
      .map((entry) => asString(entry?.font_id))
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.toLowerCase()),
  );
  const usedImportIds = new Set();
  const candidates = [];

  for (const entry of discoveredFonts) {
    if (!isObject(entry)) {
      continue;
    }

    const pathValue = asString(entry.path);
    const familyGuess = asString(entry.family_guess);
    const fontIdGuess = asString(entry.font_id_guess);
    const fileName = asString(entry.file_name) ?? "font-file";

    if (!pathValue || !familyGuess) {
      continue;
    }

    const normalizedGuess = (fontIdGuess ?? slugifyId(familyGuess, "font")).toLowerCase();
    if (existingFontIds.has(normalizedGuess)) {
      continue;
    }

    const chosenFontId = resolveUniqueFontId(fontIdGuess ?? familyGuess, usedImportIds);
    existingFontIds.add(chosenFontId.toLowerCase());

    candidates.push({
      font_id: chosenFontId,
      family_name: familyGuess,
      source_type: sourceType,
      discovered_from_path: pathValue,
      discovered_file_name: fileName,
      discovered_extension: asString(entry.extension),
    });
  }

  if (!apply) {
    printJson({
      ok: true,
      command: "import",
      dry_run: true,
      root_path: scanResult.root_path,
      source_type: sourceType,
      candidates_count: candidates.length,
      candidates,
    });
    return 0;
  }

  let updatedManifest = manifest;

  for (const candidate of candidates) {
    updatedManifest = addFontToManifest(updatedManifest, {
      font_id: candidate.font_id,
      family_name: candidate.family_name,
      source: {
        type: sourceType,
        notes: `Imported from ${candidate.discovered_from_path}`,
      },
      license_instance_ids: [],
    });
  }

  await saveManifest(resolvedManifestPath, updatedManifest);

  for (const candidate of candidates) {
    await appendProjectEvent({
      projectRoot,
      projectId: getManifestProjectId(updatedManifest),
      eventType: "manifest.font_imported",
      payload: {
        font_id: candidate.font_id,
        family_name: candidate.family_name,
        source_type: sourceType,
        discovered_from_path: candidate.discovered_from_path,
      },
    });
  }

  await appendProjectEvent({
    projectRoot,
    projectId: getManifestProjectId(updatedManifest),
    eventType: "import.completed",
    payload: {
      root_path: scanResult.root_path,
      source_type: sourceType,
      imported_count: candidates.length,
      discovered_count: discoveredFonts.length,
    },
  });

  printJson({
    ok: true,
    command: "import",
    dry_run: false,
    root_path: scanResult.root_path,
    source_type: sourceType,
    imported_count: candidates.length,
    imported: candidates,
  });

  return 0;
}

async function handleDoctor(cwd, flags) {
  const strict = getBooleanFlag(flags, "strict");
  const providedManifestPath = resolveManifestPathFromFlag(cwd, flags);
  const resolvedManifestPath = providedManifestPath ?? findUp(MANIFEST_FILENAME, cwd);
  const checks = [];
  let manifest = null;
  let projectRoot = cwd;

  if (!resolvedManifestPath) {
    checks.push(
      createDoctorCheck({
        id: "manifest.present",
        status: "error",
        message: `${MANIFEST_FILENAME} was not found in current or parent directories.`,
        fix: "Run 'setzkasten init --name \"<project>\"'.",
      }),
    );
    checks.push(
      createDoctorCheck({
        id: "manifest.valid",
        status: "skip",
        message: "Manifest validation skipped because manifest file is missing.",
      }),
    );
  } else {
    checks.push(
      createDoctorCheck({
        id: "manifest.present",
        status: "pass",
        message: `Found manifest at ${resolvedManifestPath}.`,
      }),
    );

    try {
      const loaded = await loadManifest({
        cwd,
        manifestPath: resolvedManifestPath,
      });
      manifest = loaded.manifest;
      projectRoot = loaded.projectRoot;
      checks.push(
        createDoctorCheck({
          id: "manifest.valid",
          status: "pass",
          message: "Manifest validation passed.",
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push(
        createDoctorCheck({
          id: "manifest.valid",
          status: "error",
          message: `Manifest validation failed: ${message}`,
          fix: "Run 'setzkasten migrate' or correct manifest fields to match schema.",
        }),
      );
    }
  }

  const eventLogPath = path.join(projectRoot, EVENT_LOG_RELATIVE_PATH);
  const eventLogExists = await exists(eventLogPath);

  checks.push(
    createDoctorCheck({
      id: "events.log.present",
      status: eventLogExists ? "pass" : "warn",
      message: eventLogExists ? `Found event log at ${eventLogPath}.` : "Event log is missing.",
      fix: eventLogExists ? undefined : "Run any mutating command (or 'setzkasten init') to create events log.",
    }),
  );

  if (!manifest) {
    checks.push(
      createDoctorCheck({
        id: "byo.license_linked",
        status: "skip",
        message: "BYO license linkage check skipped because manifest is unavailable.",
      }),
    );
    checks.push(
      createDoctorCheck({
        id: "byo.evidence_attached",
        status: "skip",
        message: "BYO evidence check skipped because manifest is unavailable.",
      }),
    );
  } else {
    const fonts = Array.isArray(manifest.fonts) ? manifest.fonts : [];
    const licenseInstances = Array.isArray(manifest.license_instances) ? manifest.license_instances : [];
    const instancesById = new Map();

    for (const instance of licenseInstances) {
      if (
        isObject(instance) &&
        typeof instance.license_id === "string" &&
        instance.license_id.trim().length > 0
      ) {
        instancesById.set(instance.license_id, instance);
      }
    }

    const byoFonts = fonts.filter(
      (font) => isObject(font) && isObject(font.source) && asString(font.source.type) === "byo",
    );

    const missingLinkedInstance = [];
    const missingEvidence = [];

    for (const font of byoFonts) {
      const fontId = asString(font.font_id) ?? "unknown_font";
      const linkedIds = asStringArray(font.license_instance_ids);
      const activeId = asString(font.active_license_instance_id);
      const candidateId = activeId ?? linkedIds[0] ?? null;

      if (!candidateId || !instancesById.has(candidateId)) {
        missingLinkedInstance.push(fontId);
        continue;
      }

      const licenseInstance = instancesById.get(candidateId);
      const evidence = Array.isArray(licenseInstance?.evidence) ? licenseInstance.evidence : [];

      if (evidence.length === 0) {
        missingEvidence.push({
          font_id: fontId,
          license_id: candidateId,
        });
      }
    }

    checks.push(
      createDoctorCheck({
        id: "byo.license_linked",
        status: missingLinkedInstance.length > 0 ? "warn" : "pass",
        message:
          missingLinkedInstance.length > 0
            ? `${missingLinkedInstance.length} BYO font(s) are missing a linked license instance.`
            : "All BYO fonts are linked to a license instance.",
        details: missingLinkedInstance.length > 0 ? { font_ids: missingLinkedInstance } : undefined,
        fix:
          missingLinkedInstance.length > 0
            ? "Use 'setzkasten add --license-instance-id <id> --active-license-instance-id <id>' or update manifest."
            : undefined,
      }),
    );

    checks.push(
      createDoctorCheck({
        id: "byo.evidence_attached",
        status: missingEvidence.length > 0 ? "warn" : "pass",
        message:
          missingEvidence.length > 0
            ? `${missingEvidence.length} BYO font(s) have no evidence attached.`
            : "All linked BYO license instances have evidence attached.",
        details: missingEvidence.length > 0 ? { missing_evidence: missingEvidence } : undefined,
        fix:
          missingEvidence.length > 0
            ? "Use 'setzkasten evidence add --license-id <id> --file <path>'."
            : undefined,
      }),
    );
  }

  const summary = summarizeChecks(checks);

  if (manifest) {
    await appendProjectEvent({
      projectRoot,
      projectId: getManifestProjectId(manifest),
      eventType: "doctor.completed",
      payload: {
        strict,
        summary,
      },
    });
  }

  printJson({
    ok: summary.error_count === 0,
    command: "doctor",
    strict,
    manifest_path: resolvedManifestPath ?? null,
    summary,
    checks,
  });

  if (strict) {
    return summary.overall === "pass" ? 0 : 2;
  }

  return summary.error_count > 0 ? 2 : 0;
}

async function handleEvidenceAdd(cwd, flags) {
  const manifestPath = resolveManifestPathFromFlag(cwd, flags);
  const { manifest, manifestPath: resolvedManifestPath, projectRoot } = await loadManifest({
    cwd,
    manifestPath,
  });

  const licenseId = requireStringFlag(flags, "license-id");
  const documentPath = path.resolve(cwd, requireStringFlag(flags, "file"));

  let documentBuffer;
  try {
    documentBuffer = await readFile(documentPath);
  } catch {
    throw new Error(`Could not read evidence file at ${documentPath}.`);
  }

  const upsertResult = upsertLicenseEvidence(manifest, {
    licenseId,
    evidenceId: getStringFlag(flags, "evidence-id"),
    type: getStringFlag(flags, "type") ?? "other",
    documentHash: sha256Hex(documentBuffer),
    documentName: getStringFlag(flags, "document-name") ?? path.basename(documentPath),
    documentPath: path.relative(projectRoot, documentPath),
    documentUrl: getStringFlag(flags, "document-url"),
    reference: getStringFlag(flags, "reference"),
    issuer: getStringFlag(flags, "issuer"),
    purchasedAt: getStringFlag(flags, "purchased-at"),
    notes: getStringFlag(flags, "notes"),
  });

  await saveManifest(resolvedManifestPath, upsertResult.manifest);

  await appendProjectEvent({
    projectRoot,
    projectId: getManifestProjectId(upsertResult.manifest),
    eventType: "manifest.license_ref_added",
    payload: {
      action: upsertResult.action,
      license_id: upsertResult.license_id,
      evidence_id: upsertResult.evidence.evidence_id,
      evidence_type: upsertResult.evidence.type,
      document_hash: upsertResult.evidence.document_hash,
      document_name: upsertResult.evidence.document_name ?? path.basename(documentPath),
      file_path: path.relative(projectRoot, documentPath),
    },
  });

  printJson({
    ok: true,
    command: "evidence",
    action: "add",
    manifest_path: resolvedManifestPath,
    result: upsertResult,
  });

  return 0;
}

function toComparableSet(values) {
  return new Set(
    values
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function buildEvidenceSuggestions(manifest, scanResult) {
  const suggestions = [];
  const instances = Array.isArray(manifest.license_instances) ? manifest.license_instances : [];
  const discoveredLicenseFiles = Array.isArray(scanResult.discovered_license_files)
    ? scanResult.discovered_license_files
    : [];

  for (const instance of instances) {
    if (!isObject(instance)) {
      continue;
    }

    const licenseId = asString(instance.license_id);
    if (!licenseId) {
      continue;
    }

    const fontRefs = Array.isArray(instance.font_refs) ? instance.font_refs : [];
    const fontIds = fontRefs
      .map((ref) => (isObject(ref) ? asString(ref.font_id) : null))
      .filter((entry) => typeof entry === "string");
    const fontIdSet = toComparableSet(fontIds);

    if (fontIdSet.size === 0) {
      continue;
    }

    const evidence = Array.isArray(instance.evidence) ? instance.evidence : [];
    if (evidence.length > 0) {
      continue;
    }

    const candidates = discoveredLicenseFiles
      .map((entry) => {
        const matchedFontIds = Array.isArray(entry.matched_font_ids) ? entry.matched_font_ids : [];
        const overlap = matchedFontIds.filter((fontId) => fontIdSet.has(fontId)).length;
        if (overlap === 0) {
          return null;
        }

        return {
          entry,
          overlap,
          confidence: Math.min(0.99, Number((0.45 + overlap / Math.max(1, fontIdSet.size)).toFixed(2))),
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b.overlap !== a.overlap) {
          return b.overlap - a.overlap;
        }
        return String(a.entry.path).localeCompare(String(b.entry.path));
      });

    if (candidates.length === 0) {
      continue;
    }

    const selected = candidates[0];
    suggestions.push({
      license_id: licenseId,
      evidence_type: "license_document",
      path: selected.entry.path,
      document_hash: selected.entry.document_hash,
      detected_license: asString(selected.entry.detected_license),
      matched_font_ids: Array.isArray(selected.entry.matched_font_ids) ? selected.entry.matched_font_ids : [],
      confidence: selected.confidence,
    });
  }

  return suggestions.sort((a, b) => a.license_id.localeCompare(b.license_id));
}

async function handleEvidenceSuggest(cwd, flags) {
  const manifestPath = resolveManifestPathFromFlag(cwd, flags);
  const { manifest, manifestPath: resolvedManifestPath, projectRoot } = await loadManifest({
    cwd,
    manifestPath,
  });

  const scanRoot = path.resolve(cwd, getStringFlag(flags, "path") ?? projectRoot);
  const apply = getBooleanFlag(flags, "apply");

  const scanResult = await scanProject({
    rootPath: scanRoot,
    manifest,
    maxMatchedPathsPerFont: 20,
    maxDiscoveredFiles: 200,
    maxDiscoveredLicenseFiles: 200,
    discover: true,
  });

  const suggestions = buildEvidenceSuggestions(manifest, scanResult);

  if (!apply) {
    printJson({
      ok: true,
      command: "evidence",
      action: "suggest",
      dry_run: true,
      root_path: scanResult.root_path,
      suggestions_count: suggestions.length,
      suggestions,
    });
    return 0;
  }

  let updatedManifest = manifest;
  const applied = [];

  for (const suggestion of suggestions) {
    const upsertResult = upsertLicenseEvidence(updatedManifest, {
      licenseId: suggestion.license_id,
      type: suggestion.evidence_type,
      documentHash: suggestion.document_hash,
      documentName: path.basename(suggestion.path),
      documentPath: suggestion.path,
      notes: `Suggested by evidence suggest (confidence=${suggestion.confidence})`,
    });
    updatedManifest = upsertResult.manifest;
    applied.push({
      license_id: upsertResult.license_id,
      evidence_id: upsertResult.evidence.evidence_id,
      document_hash: upsertResult.evidence.document_hash,
      path: suggestion.path,
      confidence: suggestion.confidence,
    });
  }

  await saveManifest(resolvedManifestPath, updatedManifest);

  for (const item of applied) {
    await appendProjectEvent({
      projectRoot,
      projectId: getManifestProjectId(updatedManifest),
      eventType: "manifest.license_ref_added",
      payload: {
        action: "suggested_add",
        license_id: item.license_id,
        evidence_id: item.evidence_id,
        document_hash: item.document_hash,
        file_path: item.path,
        confidence: item.confidence,
      },
    });
  }

  await appendProjectEvent({
    projectRoot,
    projectId: getManifestProjectId(updatedManifest),
    eventType: "evidence.suggested",
    payload: {
      root_path: scanResult.root_path,
      suggested_count: suggestions.length,
      applied_count: applied.length,
    },
  });

  printJson({
    ok: true,
    command: "evidence",
    action: "suggest",
    dry_run: false,
    root_path: scanResult.root_path,
    suggestions_count: suggestions.length,
    applied_count: applied.length,
    applied,
    suggestions,
  });

  return 0;
}

async function handleEvidenceVerify(cwd, flags) {
  const manifestPath = resolveManifestPathFromFlag(cwd, flags);
  const { manifest, projectRoot } = await loadManifest({
    cwd,
    manifestPath,
  });

  const strict = getBooleanFlag(flags, "strict");
  const instances = Array.isArray(manifest.license_instances) ? manifest.license_instances : [];
  const findings = [];

  for (const instance of instances) {
    if (!isObject(instance)) {
      continue;
    }

    const licenseId = asString(instance.license_id) ?? "unknown_license";
    const evidenceItems = Array.isArray(instance.evidence) ? instance.evidence : [];

    for (const evidence of evidenceItems) {
      if (!isObject(evidence)) {
        continue;
      }

      const evidenceId = asString(evidence.evidence_id) ?? "unknown_evidence";
      const documentHash = asString(evidence.document_hash);
      const documentPath = asString(evidence.document_path);

      if (!documentPath) {
        findings.push({
          license_id: licenseId,
          evidence_id: evidenceId,
          status: "missing_path",
          message: "Evidence entry does not include document_path.",
        });
        continue;
      }

      const absolutePath = path.resolve(projectRoot, documentPath);
      let fileBuffer;
      try {
        fileBuffer = await readFile(absolutePath);
      } catch {
        findings.push({
          license_id: licenseId,
          evidence_id: evidenceId,
          status: "missing_file",
          path: documentPath,
          message: `Evidence file not found at ${documentPath}.`,
        });
        continue;
      }

      const hash = sha256Hex(fileBuffer);
      if (!documentHash || hash.toLowerCase() !== documentHash.toLowerCase()) {
        findings.push({
          license_id: licenseId,
          evidence_id: evidenceId,
          status: "hash_mismatch",
          path: documentPath,
          expected_hash: documentHash,
          actual_hash: hash,
          message: "Evidence hash does not match current file contents.",
        });
        continue;
      }

      findings.push({
        license_id: licenseId,
        evidence_id: evidenceId,
        status: "ok",
        path: documentPath,
        message: "Evidence file and hash are valid.",
      });
    }
  }

  const summary = {
    ok_count: findings.filter((entry) => entry.status === "ok").length,
    missing_path_count: findings.filter((entry) => entry.status === "missing_path").length,
    missing_file_count: findings.filter((entry) => entry.status === "missing_file").length,
    hash_mismatch_count: findings.filter((entry) => entry.status === "hash_mismatch").length,
  };
  const failureCount = summary.missing_path_count + summary.missing_file_count + summary.hash_mismatch_count;

  await appendProjectEvent({
    projectRoot,
    projectId: getManifestProjectId(manifest),
    eventType: "evidence.verified",
    payload: {
      strict,
      summary,
      checked_count: findings.length,
    },
  });

  printJson({
    ok: failureCount === 0,
    command: "evidence",
    action: "verify",
    strict,
    summary,
    findings,
  });

  if (strict && failureCount > 0) {
    return 2;
  }

  return 0;
}

async function handleEvidence(cwd, flags, positionals) {
  const action = positionals[0] ?? "add";

  if (action === "add") {
    return handleEvidenceAdd(cwd, flags);
  }

  if (action === "suggest") {
    return handleEvidenceSuggest(cwd, flags);
  }

  if (action === "verify") {
    return handleEvidenceVerify(cwd, flags);
  }

  throw new Error(`Unknown evidence action '${action}'. Supported: add, suggest, verify`);
}

function isPolicyExceptionExpired(exception, now = new Date()) {
  const expiresAt = asString(exception?.expires_at);
  if (!expiresAt) {
    return false;
  }

  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.valueOf())) {
    return false;
  }

  return parsed.getTime() <= now.getTime();
}

function readPolicyExceptions(manifest) {
  if (!Array.isArray(manifest.policy_exceptions)) {
    return [];
  }

  return manifest.policy_exceptions.filter((entry) => isObject(entry));
}

async function handleExceptionAdd(cwd, flags) {
  const manifestPath = resolveManifestPathFromFlag(cwd, flags);
  const { manifest, manifestPath: resolvedManifestPath, projectRoot } = await loadManifest({
    cwd,
    manifestPath,
  });

  const code = requireStringFlag(flags, "code");
  const reason = getStringFlag(flags, "reason") ?? "No reason provided";
  const fontId = getStringFlag(flags, "font-id");
  const licenseId = getStringFlag(flags, "license-id");
  const expiresAt = getStringFlag(flags, "expires-at");
  const exceptionId = getStringFlag(flags, "exception-id") ?? slugifyId(`${code}-${Date.now()}`, "exception");

  if (!Array.isArray(manifest.policy_exceptions)) {
    manifest.policy_exceptions = [];
  }

  if (
    manifest.policy_exceptions.some(
      (entry) => isObject(entry) && asString(entry.exception_id) === exceptionId,
    )
  ) {
    throw new Error(`Policy exception '${exceptionId}' already exists.`);
  }

  const exception = {
    exception_id: exceptionId,
    code,
    reason,
    created_at: new Date().toISOString(),
  };

  if (fontId) {
    exception.font_id = fontId;
  }
  if (licenseId) {
    exception.license_id = licenseId;
  }
  if (expiresAt) {
    exception.expires_at = expiresAt;
  }

  manifest.policy_exceptions.push(exception);
  await saveManifest(resolvedManifestPath, manifest);

  await appendProjectEvent({
    projectRoot,
    projectId: getManifestProjectId(manifest),
    eventType: "policy.exception_added",
    payload: exception,
  });

  printJson({
    ok: true,
    command: "exception",
    action: "add",
    exception,
  });

  return 0;
}

async function handleExceptionList(cwd, flags) {
  const manifestPath = resolveManifestPathFromFlag(cwd, flags);
  const { manifest } = await loadManifest({
    cwd,
    manifestPath,
  });

  const exceptions = readPolicyExceptions(manifest).map((entry) => ({
    ...entry,
    active: !isPolicyExceptionExpired(entry),
  }));

  printJson({
    ok: true,
    command: "exception",
    action: "list",
    count: exceptions.length,
    exceptions,
  });

  return 0;
}

async function handleExceptionRemove(cwd, flags) {
  const manifestPath = resolveManifestPathFromFlag(cwd, flags);
  const { manifest, manifestPath: resolvedManifestPath, projectRoot } = await loadManifest({
    cwd,
    manifestPath,
  });

  const exceptionId = requireStringFlag(flags, "exception-id");
  const current = readPolicyExceptions(manifest);
  const filtered = current.filter((entry) => asString(entry.exception_id) !== exceptionId);

  if (filtered.length === current.length) {
    throw new Error(`Policy exception '${exceptionId}' not found.`);
  }

  manifest.policy_exceptions = filtered;
  await saveManifest(resolvedManifestPath, manifest);

  await appendProjectEvent({
    projectRoot,
    projectId: getManifestProjectId(manifest),
    eventType: "policy.exception_removed",
    payload: {
      exception_id: exceptionId,
    },
  });

  printJson({
    ok: true,
    command: "exception",
    action: "remove",
    exception_id: exceptionId,
  });

  return 0;
}

async function handleException(cwd, flags, positionals) {
  const action = positionals[0] ?? "list";

  if (action === "add") {
    return handleExceptionAdd(cwd, flags);
  }

  if (action === "list") {
    return handleExceptionList(cwd, flags);
  }

  if (action === "remove") {
    return handleExceptionRemove(cwd, flags);
  }

  throw new Error(`Unknown exception action '${action}'. Supported: add, list, remove`);
}

async function handlePolicy(cwd, flags, positionals) {
  const action = positionals[0];

  if (action === "presets") {
    printJson({
      ok: true,
      command: "policy",
      action: "presets",
      presets: POLICY_PRESETS.map((name) => ({ name })),
    });
    return 0;
  }

  if (action) {
    throw new Error(`Unknown policy action '${action}'. Supported: presets`);
  }

  const manifestPath = resolveManifestPathFromFlag(cwd, flags);
  const { manifest, projectRoot } = await loadManifest({
    cwd,
    manifestPath,
  });

  const preset = getStringFlag(flags, "preset");
  const basePolicy = evaluatePolicy(manifest);
  const policy = preset ? applyPolicyPreset(basePolicy, preset) : basePolicy;

  await appendProjectEvent({
    projectRoot,
    projectId: getManifestProjectId(manifest),
    eventType: policy.decision === "allow" ? "policy.ok" : "policy.warning_raised",
    payload: {
      decision: policy.decision,
      reasons_count: policy.reasons.length,
      evidence_required: policy.evidence_required,
      preset: preset ?? null,
    },
  });

  const format = getOutputFormat(flags);
  const findings = policyToFindings(policy);
  if (format === "json") {
    printJson(policy);
  } else if (format === "sarif") {
    printJson(findingsToSarif("policy", findings));
  } else {
    printText(findingsToJunit("setzkasten.policy", findings));
  }

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
  const providedManifestPath = resolveManifestPathFromFlag(cwd, flags);
  const resolvedManifestPath = providedManifestPath ?? findUp(MANIFEST_FILENAME, cwd);
  if (!resolvedManifestPath) {
    throw new Error(
      `${MANIFEST_FILENAME} was not found in current or parent directories. Run 'setzkasten init' first.`,
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolvedManifestPath, "utf8"));
  } catch {
    throw new Error(`Could not read manifest from ${resolvedManifestPath}.`);
  }

  const projectRoot = path.dirname(resolvedManifestPath);

  const targetVersion = getStringFlag(flags, "to-version") ?? MANIFEST_VERSION;
  const apply = getBooleanFlag(flags, "apply");
  const currentVersion =
    typeof manifest.manifest_version === "string" ? manifest.manifest_version : "unknown";

  if (targetVersion !== MANIFEST_VERSION) {
    throw new Error(
      `Unsupported target version '${targetVersion}'. Supported target: ${MANIFEST_VERSION}.`,
    );
  }

  const nextManifest = JSON.parse(JSON.stringify(manifest));
  const actions = [];

  if (nextManifest.manifest_version !== targetVersion) {
    nextManifest.manifest_version = targetVersion;
    actions.push({
      id: "set_manifest_version",
      from: currentVersion,
      to: targetVersion,
    });
  }

  if (!Array.isArray(nextManifest.fonts)) {
    nextManifest.fonts = [];
    actions.push({
      id: "initialize_fonts_array",
    });
  }

  if (!Array.isArray(nextManifest.license_instances)) {
    nextManifest.license_instances = [];
    actions.push({
      id: "initialize_license_instances_array",
    });
  }

  if (!Array.isArray(nextManifest.licensees)) {
    nextManifest.licensees = [];
    actions.push({
      id: "initialize_licensees_array",
    });
  }

  if (!isObject(nextManifest.project)) {
    nextManifest.project = {
      project_id: slugifyId(path.basename(projectRoot), "project"),
      name: path.basename(projectRoot),
    };
    actions.push({
      id: "initialize_project_object",
    });
  }

  const migrationPlan = {
    dry_run: !apply,
    from_manifest_version: currentVersion,
    to_manifest_version: targetVersion,
    actions,
    no_op: actions.length === 0,
  };

  if (!apply) {
    const projectId = isObject(manifest.project) && asString(manifest.project.project_id)
      ? manifest.project.project_id
      : slugifyId(path.basename(projectRoot), "project");
    await appendProjectEvent({
      projectRoot,
      projectId,
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

  let backupPath = null;
  if (actions.length > 0) {
    backupPath = `${resolvedManifestPath}.backup-${Date.now()}.json`;
    await writeFile(backupPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await saveManifest(resolvedManifestPath, nextManifest);
  }

  await appendProjectEvent({
    projectRoot,
    projectId:
      (isObject(nextManifest.project) && asString(nextManifest.project.project_id)) ||
      (isObject(manifest.project) && asString(manifest.project.project_id)) ||
      slugifyId(path.basename(projectRoot), "project"),
    eventType: "migration.applied",
    payload: {
      ...migrationPlan,
      backup_path: backupPath,
    },
  });

  printJson({
    ok: true,
    command: "migrate",
    migration: {
      ...migrationPlan,
      dry_run: false,
      applied: true,
      backup_path: backupPath,
    },
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
    case "import":
      return handleImport(cwd, parsed.flags);
    case "doctor":
      return handleDoctor(cwd, parsed.flags);
    case "evidence":
      return handleEvidence(cwd, parsed.flags, parsed.positionals);
    case "exception":
      return handleException(cwd, parsed.flags, parsed.positionals);
    case "policy":
      return handlePolicy(cwd, parsed.flags, parsed.positionals);
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
