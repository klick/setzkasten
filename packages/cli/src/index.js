#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { MANIFEST_FILENAME, parseListFlag, sha256Hex, slugifyId } from "./lib/core.js";
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

const PRUNE_RULES = new Set(["no-file-and-no-usage", "no-file"]);

function printHelp() {
  const helpText = `Setzkasten CLI (V1)

Usage:
  setzkasten <command> [options]

Commands:
  init      Create ${MANIFEST_FILENAME} and .setzkasten/events.log
  add       Add font entry to manifest
  remove    Remove font entry from manifest
  scan      Scan local repository usage and optionally discover font/license files
  prune     Remove manifest noise based on discovered font files and usage signals
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
Prune options:
  --path <dir>                 Directory to scan for prune evaluation (default: project root)
  --rule <name>                no-file-and-no-usage (default) | no-file
  --apply                      Apply removals (default is dry-run)
  --max-removals <n>           Safety limit for removals when --apply is used (default: 50)
Evidence options:
  setzkasten evidence add --license-id <id> --file <path>
    [--type <type>] [--evidence-id <id>] [--document-name <name>]
    [--document-url <uri>] [--reference <id>] [--issuer <name>]
    [--purchased-at <iso-date-time>] [--notes <text>]

Examples:
  setzkasten init --name "Acme Project"
  setzkasten add --font-id inter --family "Inter" --source oss
  setzkasten scan --path . --discover
  setzkasten prune --path . --rule no-file-and-no-usage
  setzkasten prune --path . --apply
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

function normalizeComparable(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function buildDiscoveredFontIndex(scanResult) {
  const discoveredFonts = Array.isArray(scanResult.discovered_font_files)
    ? scanResult.discovered_font_files
    : [];
  const byFontIdGuess = new Set();
  const byFamilyGuess = new Set();

  for (const entry of discoveredFonts) {
    if (!isObject(entry)) {
      continue;
    }

    const fontIdGuess = asString(entry.font_id_guess);
    if (fontIdGuess) {
      byFontIdGuess.add(fontIdGuess.toLowerCase());
    }

    const familyGuess = normalizeComparable(asString(entry.family_guess));
    if (familyGuess) {
      byFamilyGuess.add(familyGuess);
    }
  }

  return { byFontIdGuess, byFamilyGuess };
}

function hasDiscoveredFontFile(font, discoveredIndex) {
  if (!isObject(font)) {
    return false;
  }

  const fontId = asString(font.font_id);
  if (fontId && discoveredIndex.byFontIdGuess.has(fontId.toLowerCase())) {
    return true;
  }

  const familyName = normalizeComparable(asString(font.family_name));
  if (familyName && discoveredIndex.byFamilyGuess.has(familyName)) {
    return true;
  }

  return false;
}

function getUsageMatchCount(font, scanResult) {
  const fontId = isObject(font) ? asString(font.font_id) : null;
  if (fontId && isObject(scanResult.font_matches) && isObject(scanResult.font_matches[fontId])) {
    const matchedPaths = Array.isArray(scanResult.font_matches[fontId].matched_paths)
      ? scanResult.font_matches[fontId].matched_paths
      : [];
    const relevantMatchedPaths = matchedPaths.filter(
      (entry) =>
        typeof entry === "string" &&
        entry !== MANIFEST_FILENAME &&
        !entry.startsWith(".setzkasten/"),
    );

    if (relevantMatchedPaths.length > 0) {
      return relevantMatchedPaths.length;
    }

    const count = scanResult.font_matches[fontId].match_count;
    if (
      typeof count === "number" &&
      Number.isFinite(count) &&
      count >= 0 &&
      matchedPaths.length === 0
    ) {
      return count;
    }

    return 0;
  }

  if (isObject(font) && isObject(font.usage) && isObject(font.usage.scan)) {
    const count = font.usage.scan.match_count;
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
      return count;
    }
  }

  return 0;
}

function buildPruneCandidates(manifest, scanResult, rule) {
  const fonts = Array.isArray(manifest.fonts) ? manifest.fonts : [];
  const discoveredIndex = buildDiscoveredFontIndex(scanResult);
  const candidates = [];

  for (const font of fonts) {
    if (!isObject(font)) {
      continue;
    }

    const fontId = asString(font.font_id);
    const familyName = asString(font.family_name);
    if (!fontId || !familyName) {
      continue;
    }

    const hasFile = hasDiscoveredFontFile(font, discoveredIndex);
    const usageMatchCount = getUsageMatchCount(font, scanResult);
    const noUsage = usageMatchCount === 0;

    const reasons = [];
    if (!hasFile) {
      reasons.push("missing_font_file");
    }
    if (noUsage) {
      reasons.push("no_usage_refs");
    }

    let selected = false;
    if (rule === "no-file-and-no-usage") {
      selected = !hasFile && noUsage;
    } else if (rule === "no-file") {
      selected = !hasFile;
    }

    if (!selected) {
      continue;
    }

    const linkedLicenseIds = new Set([
      ...asStringArray(font.license_instance_ids),
      asString(font.active_license_instance_id),
    ]);

    candidates.push({
      font_id: fontId,
      family_name: familyName,
      reasons,
      has_discovered_file: hasFile,
      usage_match_count: usageMatchCount,
      linked_license_ids: Array.from(linkedLicenseIds).filter(Boolean).sort((a, b) => a.localeCompare(b)),
    });
  }

  return candidates.sort((a, b) => a.font_id.localeCompare(b.font_id));
}

function removeLinkedLicenseInstances(manifest, removedFonts) {
  const licenseInstances = Array.isArray(manifest.license_instances) ? manifest.license_instances : [];
  if (licenseInstances.length === 0 || removedFonts.length === 0) {
    return { manifest, removedLicenseInstances: [] };
  }

  const removedLinkedLicenseIds = new Set();
  for (const font of removedFonts) {
    for (const licenseId of asStringArray(font.license_instance_ids)) {
      removedLinkedLicenseIds.add(licenseId);
    }
    const activeId = asString(font.active_license_instance_id);
    if (activeId) {
      removedLinkedLicenseIds.add(activeId);
    }
  }

  if (removedLinkedLicenseIds.size === 0) {
    return { manifest, removedLicenseInstances: [] };
  }

  const remainingFonts = Array.isArray(manifest.fonts) ? manifest.fonts : [];
  const stillReferencedLicenseIds = new Set();
  for (const font of remainingFonts) {
    if (!isObject(font)) {
      continue;
    }
    for (const licenseId of asStringArray(font.license_instance_ids)) {
      stillReferencedLicenseIds.add(licenseId);
    }
    const activeId = asString(font.active_license_instance_id);
    if (activeId) {
      stillReferencedLicenseIds.add(activeId);
    }
  }

  const removedLicenseInstances = [];
  manifest.license_instances = licenseInstances.filter((instance) => {
    if (!isObject(instance)) {
      return true;
    }

    const licenseId = asString(instance.license_id);
    if (!licenseId) {
      return true;
    }

    if (!removedLinkedLicenseIds.has(licenseId) || stillReferencedLicenseIds.has(licenseId)) {
      return true;
    }

    removedLicenseInstances.push({
      license_id: licenseId,
      status: asString(instance.status) ?? null,
    });
    return false;
  });

  const remainingLicenseIds = new Set(
    manifest.license_instances
      .filter((entry) => isObject(entry))
      .map((entry) => asString(entry.license_id))
      .filter(Boolean),
  );

  for (const font of remainingFonts) {
    if (!isObject(font)) {
      continue;
    }

    font.license_instance_ids = asStringArray(font.license_instance_ids).filter((licenseId) =>
      remainingLicenseIds.has(licenseId),
    );

    const activeId = asString(font.active_license_instance_id);
    if (activeId && !remainingLicenseIds.has(activeId)) {
      delete font.active_license_instance_id;
    }
  }

  return { manifest, removedLicenseInstances };
}

function applyPruneCandidates(manifest, candidates, maxRemovals) {
  const limitedCandidates = candidates.slice(0, maxRemovals);
  const candidateByFontId = new Map(limitedCandidates.map((candidate) => [candidate.font_id, candidate]));
  const draft = JSON.parse(JSON.stringify(manifest));
  const fonts = Array.isArray(draft.fonts) ? draft.fonts : [];
  const removedFonts = [];
  const keptFonts = [];

  for (const font of fonts) {
    if (!isObject(font)) {
      keptFonts.push(font);
      continue;
    }

    const fontId = asString(font.font_id);
    if (!fontId || !candidateByFontId.has(fontId)) {
      keptFonts.push(font);
      continue;
    }

    removedFonts.push({
      font_id: fontId,
      family_name: asString(font.family_name) ?? fontId,
      reasons: candidateByFontId.get(fontId).reasons,
      linked_license_ids: candidateByFontId.get(fontId).linked_license_ids,
      license_instance_ids: asStringArray(font.license_instance_ids),
      active_license_instance_id: asString(font.active_license_instance_id),
    });
  }

  draft.fonts = keptFonts;
  const withLicenseCleanup = removeLinkedLicenseInstances(draft, removedFonts);

  return {
    manifest: withLicenseCleanup.manifest,
    removedFonts,
    removedLicenseInstances: withLicenseCleanup.removedLicenseInstances,
    skippedCandidates: candidates.length - limitedCandidates.length,
  };
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

async function handlePrune(cwd, flags) {
  const manifestPath = resolveManifestPathFromFlag(cwd, flags);
  const { manifest, manifestPath: resolvedManifestPath, projectRoot } = await loadManifest({
    cwd,
    manifestPath,
  });

  const scanRoot = path.resolve(cwd, getStringFlag(flags, "path") ?? projectRoot);
  const apply = getBooleanFlag(flags, "apply");
  const rule = getStringFlag(flags, "rule") ?? "no-file-and-no-usage";
  const maxRemovalsInput = Number(getStringFlag(flags, "max-removals") ?? "50");
  const maxRemovals = Number.isFinite(maxRemovalsInput) && maxRemovalsInput > 0 ? maxRemovalsInput : 50;

  if (!PRUNE_RULES.has(rule)) {
    throw new Error(`--rule must be one of: ${Array.from(PRUNE_RULES).join(", ")}`);
  }

  const scanResult = await scanProject({
    rootPath: scanRoot,
    manifest,
    maxMatchedPathsPerFont: 30,
    maxDiscoveredFiles: 500,
    maxDiscoveredLicenseFiles: 0,
    discover: true,
  });

  const manifestWithScan = applyScanResultToManifest(manifest, scanResult);
  const candidates = buildPruneCandidates(manifestWithScan, scanResult, rule);

  if (!apply) {
    printJson({
      ok: true,
      command: "prune",
      dry_run: true,
      rule,
      root_path: scanResult.root_path,
      candidates_count: candidates.length,
      max_removals: maxRemovals,
      candidates,
    });
    return 0;
  }

  const pruneResult = applyPruneCandidates(manifestWithScan, candidates, maxRemovals);
  await saveManifest(resolvedManifestPath, pruneResult.manifest);

  for (const removedFont of pruneResult.removedFonts) {
    await appendProjectEvent({
      projectRoot,
      projectId: getManifestProjectId(pruneResult.manifest),
      eventType: "manifest.font_pruned",
      payload: {
        font_id: removedFont.font_id,
        family_name: removedFont.family_name,
        reasons: removedFont.reasons,
        rule,
      },
    });
  }

  for (const removedInstance of pruneResult.removedLicenseInstances) {
    await appendProjectEvent({
      projectRoot,
      projectId: getManifestProjectId(pruneResult.manifest),
      eventType: "manifest.license_instance_pruned",
      payload: {
        license_id: removedInstance.license_id,
        status: removedInstance.status,
        rule,
      },
    });
  }

  await appendProjectEvent({
    projectRoot,
    projectId: getManifestProjectId(pruneResult.manifest),
    eventType: "prune.completed",
    payload: {
      rule,
      root_path: scanResult.root_path,
      candidates_count: candidates.length,
      removed_count: pruneResult.removedFonts.length,
      removed_license_instances_count: pruneResult.removedLicenseInstances.length,
      skipped_candidates: pruneResult.skippedCandidates,
    },
  });

  printJson({
    ok: true,
    command: "prune",
    dry_run: false,
    rule,
    root_path: scanResult.root_path,
    candidates_count: candidates.length,
    removed_count: pruneResult.removedFonts.length,
    removed_license_instances_count: pruneResult.removedLicenseInstances.length,
    skipped_candidates: pruneResult.skippedCandidates,
    removed_fonts: pruneResult.removedFonts,
    removed_license_instances: pruneResult.removedLicenseInstances,
  });

  return 0;
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
    case "prune":
      return handlePrune(cwd, parsed.flags);
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
