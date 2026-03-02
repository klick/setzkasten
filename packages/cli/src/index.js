#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  EVENT_LOG_RELATIVE_PATH,
  MANIFEST_FILENAME,
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
  scan      Scan local repository usage and optionally discover font/license files
  import    Import manifest font entries from discovered repository font files
  doctor    Diagnose manifest and evidence readiness for CI usage
  evidence  Attach/update license evidence from local files
  policy    Evaluate policy decision (allow|warn|escalate)
  quote     Generate deterministic quote from license schema data
  migrate   Generate migration stub plan

Common options:
  --manifest <path>   Explicit path to ${MANIFEST_FILENAME}
Scan options:
  --path <dir>                 Directory to scan (default: project root)
  --discover                        Discover existing font files and font-adjacent license files
  --max-discovered-files <n>        Max discovered font files in output (default: 200)
  --max-discovered-license-files <n> Max discovered license files in output (default: 200)
Import options:
  --path <dir>                 Directory to scan for import candidates (default: project root)
  --source <oss|byo>           Source type assigned to imported fonts (default: byo)
  --apply                      Apply candidate imports (default is dry-run)
Evidence options:
  setzkasten evidence add --license-id <id> --file <path>
    [--type <type>] [--evidence-id <id>] [--document-name <name>]
    [--document-url <uri>] [--reference <id>] [--issuer <name>]
    [--purchased-at <iso-date-time>] [--notes <text>]

Examples:
  setzkasten init --name "Acme Project"
  setzkasten import --path .
  setzkasten import --path . --apply
  setzkasten add --font-id inter --family "Inter" --source oss
  setzkasten scan --path . --discover
  setzkasten evidence add --license-id lic_web_001 --file ./licenses/OFL.txt
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

  printJson({
    ok: true,
    command: "scan",
    result: scanResult,
  });

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

async function handleEvidence(cwd, flags, positionals) {
  const action = positionals[0] ?? "add";

  if (action !== "add") {
    throw new Error(`Unknown evidence action '${action}'. Supported: add`);
  }

  return handleEvidenceAdd(cwd, flags);
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
    case "import":
      return handleImport(cwd, parsed.flags);
    case "doctor":
      return handleDoctor(cwd, parsed.flags);
    case "evidence":
      return handleEvidence(cwd, parsed.flags, parsed.positionals);
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
