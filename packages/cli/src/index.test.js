import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./index.js", import.meta.url));

function runCli(entryPath, args, options = {}) {
  return spawnSync(process.execPath, [entryPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
  });
}

test("runs and prints help when invoked directly", () => {
  const result = runCli(scriptPath, ["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Setzkasten CLI \(V1\)/);
});

test("scan --discover prints discovered font files", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-discover-"));
  mkdirSync(path.join(tempDir, "assets", "fonts"), { recursive: true });
  writeFileSync(path.join(tempDir, "assets", "fonts", "Inter-Regular.woff2"), "font-binary");
  writeFileSync(path.join(tempDir, "LICENSE.txt"), "MIT License", "utf8");
  writeFileSync(
    path.join(tempDir, "assets", "fonts", "LICENSE.txt"),
    "SIL OPEN FONT LICENSE Version 1.1\nFont Family: Inter",
    "utf8",
  );

  const initResult = runCli(scriptPath, ["init", "--name", "Demo"], { cwd: tempDir });
  assert.equal(initResult.status, 0);

  const addResult = runCli(
    scriptPath,
    ["add", "--font-id", "inter", "--family", "Inter", "--source", "oss"],
    { cwd: tempDir },
  );
  assert.equal(addResult.status, 0);

  const scanResult = runCli(scriptPath, ["scan", "--path", ".", "--discover"], { cwd: tempDir });
  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(scanResult.status, 0);

  const parsed = JSON.parse(scanResult.stdout);
  assert.equal(parsed.command, "scan");
  assert.ok(Array.isArray(parsed.result.discovered_font_files));
  assert.ok(parsed.result.discovered_font_files.length >= 1);
  assert.ok(Array.isArray(parsed.result.discovered_license_files));
  assert.ok(parsed.result.discovered_license_files.length >= 1);
  assert.equal(
    parsed.result.discovered_license_files.some((entry) => entry.path === "LICENSE.txt"),
    false,
  );
});

test("scan supports --format sarif", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-scan-sarif-"));
  mkdirSync(path.join(tempDir, "assets", "fonts"), { recursive: true });
  writeFileSync(path.join(tempDir, "assets", "fonts", "Inter-Regular.woff2"), "font-binary");

  const initResult = runCli(scriptPath, ["init", "--name", "Scan Sarif Demo"], { cwd: tempDir });
  assert.equal(initResult.status, 0);
  const addResult = runCli(
    scriptPath,
    ["add", "--font-id", "inter", "--family", "Inter", "--source", "oss"],
    { cwd: tempDir },
  );
  assert.equal(addResult.status, 0);

  const scanResult = runCli(scriptPath, ["scan", "--path", ".", "--discover", "--format", "sarif"], {
    cwd: tempDir,
  });
  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(scanResult.status, 0);
  const parsed = JSON.parse(scanResult.stdout);
  assert.equal(parsed.version, "2.1.0");
  assert.equal(Array.isArray(parsed.runs), true);
  assert.equal(parsed.runs.length > 0, true);
});

test("policy supports --format junit", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-policy-junit-"));
  const initResult = runCli(scriptPath, ["init", "--name", "Policy JUnit Demo"], { cwd: tempDir });
  assert.equal(initResult.status, 0);

  const addResult = runCli(
    scriptPath,
    ["add", "--font-id", "ghost", "--family", "Ghost", "--source", "byo"],
    { cwd: tempDir },
  );
  assert.equal(addResult.status, 0);

  const policyResult = runCli(scriptPath, ["policy", "--format", "junit"], { cwd: tempDir });
  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(policyResult.status, 0);
  assert.match(policyResult.stdout, /<testsuite/);
  assert.match(policyResult.stdout, /<failure/);
});

test("policy presets command lists available presets", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-policy-presets-"));
  const result = runCli(scriptPath, ["policy", "presets"], { cwd: tempDir });
  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.action, "presets");
  assert.equal(Array.isArray(parsed.presets), true);
  assert.equal(parsed.presets.some((entry) => entry.name === "strict"), true);
});

test("policy strict preset escalates warnings", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-policy-strict-"));
  const initResult = runCli(scriptPath, ["init", "--name", "Policy Preset Demo"], { cwd: tempDir });
  assert.equal(initResult.status, 0);

  const addResult = runCli(
    scriptPath,
    ["add", "--font-id", "ghost", "--family", "Ghost", "--source", "byo"],
    { cwd: tempDir },
  );
  assert.equal(addResult.status, 0);

  const defaultPolicy = runCli(scriptPath, ["policy"], { cwd: tempDir });
  assert.equal(defaultPolicy.status, 0);
  const defaultParsed = JSON.parse(defaultPolicy.stdout);
  assert.equal(defaultParsed.decision, "warn");

  const strictPolicy = runCli(scriptPath, ["policy", "--preset", "strict"], { cwd: tempDir });
  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(strictPolicy.status, 2);
  const strictParsed = JSON.parse(strictPolicy.stdout);
  assert.equal(strictParsed.decision, "escalate");
  assert.equal(strictParsed.preset_applied, "strict");
});

test("import dry-run lists candidates without mutating manifest", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-import-dry-"));
  mkdirSync(path.join(tempDir, "assets", "fonts"), { recursive: true });
  writeFileSync(path.join(tempDir, "assets", "fonts", "Merriweather-Regular.woff2"), "font-binary");

  const initResult = runCli(scriptPath, ["init", "--name", "Import Dry Run Demo"], { cwd: tempDir });
  assert.equal(initResult.status, 0);

  const importResult = runCli(scriptPath, ["import", "--path", "."], { cwd: tempDir });
  assert.equal(importResult.status, 0);

  const parsed = JSON.parse(importResult.stdout);
  assert.equal(parsed.command, "import");
  assert.equal(parsed.dry_run, true);
  assert.equal(parsed.candidates_count, 1);
  assert.equal(parsed.candidates[0].family_name, "Merriweather");

  const manifest = JSON.parse(readFileSync(path.join(tempDir, "LICENSE_MANIFEST.json"), "utf8"));
  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(manifest.fonts.length, 0);
});

test("import --apply adds discovered font candidates to manifest", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-import-apply-"));
  mkdirSync(path.join(tempDir, "assets", "fonts"), { recursive: true });
  writeFileSync(path.join(tempDir, "assets", "fonts", "Merriweather-Regular.woff2"), "font-binary");
  writeFileSync(path.join(tempDir, "assets", "fonts", "Roboto-Regular.woff2"), "font-binary");

  const initResult = runCli(scriptPath, ["init", "--name", "Import Apply Demo"], { cwd: tempDir });
  assert.equal(initResult.status, 0);

  const importResult = runCli(scriptPath, ["import", "--path", ".", "--apply"], { cwd: tempDir });
  assert.equal(importResult.status, 0);
  const parsed = JSON.parse(importResult.stdout);
  assert.equal(parsed.command, "import");
  assert.equal(parsed.dry_run, false);
  assert.equal(parsed.imported_count, 2);

  const manifest = JSON.parse(readFileSync(path.join(tempDir, "LICENSE_MANIFEST.json"), "utf8"));
  assert.equal(manifest.fonts.length, 2);
  assert.equal(manifest.fonts.every((font) => font.source.type === "byo"), true);

  const eventsLogPath = path.join(tempDir, ".setzkasten", "events.log");
  const eventTypes = readFileSync(eventsLogPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).event_type);

  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(eventTypes.includes("manifest.font_imported"), true);
  assert.equal(eventTypes.includes("import.completed"), true);
});

test("doctor reports missing manifest and exits non-zero", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-doctor-missing-"));
  const doctorResult = runCli(scriptPath, ["doctor"], { cwd: tempDir });
  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(doctorResult.status, 2);
  const parsed = JSON.parse(doctorResult.stdout);
  assert.equal(parsed.command, "doctor");
  assert.equal(parsed.summary.overall, "error");
  assert.equal(parsed.checks.some((entry) => entry.id === "manifest.present" && entry.status === "error"), true);
});

test("doctor warns for missing BYO links/evidence and strict mode fails", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-doctor-warn-"));

  const initResult = runCli(scriptPath, ["init", "--name", "Doctor Warn Demo"], { cwd: tempDir });
  assert.equal(initResult.status, 0);

  const addResult = runCli(
    scriptPath,
    ["add", "--font-id", "ghost", "--family", "Ghost", "--source", "byo"],
    { cwd: tempDir },
  );
  assert.equal(addResult.status, 0);

  const doctorResult = runCli(scriptPath, ["doctor"], { cwd: tempDir });
  assert.equal(doctorResult.status, 0);
  const parsed = JSON.parse(doctorResult.stdout);
  assert.equal(parsed.summary.overall, "warn");
  assert.equal(parsed.checks.some((entry) => entry.id === "byo.license_linked" && entry.status === "warn"), true);

  const strictResult = runCli(scriptPath, ["doctor", "--strict"], { cwd: tempDir });
  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(strictResult.status, 2);
  const strictParsed = JSON.parse(strictResult.stdout);
  assert.equal(strictParsed.summary.overall, "warn");
});

test("doctor strict passes when BYO license linkage and evidence are complete", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-doctor-pass-"));
  const initResult = runCli(scriptPath, ["init", "--name", "Doctor Pass Demo"], { cwd: tempDir });
  assert.equal(initResult.status, 0);

  const addResult = runCli(
    scriptPath,
    [
      "add",
      "--font-id",
      "ibm-plex-sans",
      "--family",
      "IBM Plex Sans",
      "--source",
      "byo",
      "--license-instance-id",
      "lic_plex_001",
      "--active-license-instance-id",
      "lic_plex_001",
    ],
    { cwd: tempDir },
  );
  assert.equal(addResult.status, 0);

  const manifestPath = path.join(tempDir, "LICENSE_MANIFEST.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.license_instances.push({
    kind: "instance",
    license_id: "lic_plex_001",
    licensee_id: manifest.licensees[0].licensee_id,
    offering_ref: {
      offering_id: "off_plex_web",
      offering_version: "1.0.0",
    },
    scope: {
      scope_type: "project",
      scope_id: manifest.project.project_id,
    },
    font_refs: [
      {
        font_id: "ibm-plex-sans",
        family_name: "IBM Plex Sans",
      },
    ],
    activated_right_ids: ["media_web"],
    status: "active",
    evidence: [{ evidence_id: "ev_plex_001", type: "invoice", document_hash: "a".repeat(64) }],
    acquisition_source: "direct_foundry",
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const doctorResult = runCli(scriptPath, ["doctor", "--strict"], { cwd: tempDir });
  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(doctorResult.status, 0);
  const parsed = JSON.parse(doctorResult.stdout);
  assert.equal(parsed.summary.overall, "pass");
  assert.equal(parsed.checks.some((entry) => entry.id === "byo.evidence_attached" && entry.status === "pass"), true);
});

test("evidence suggest proposes discovered license files for empty license instances", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-evidence-suggest-"));
  mkdirSync(path.join(tempDir, "assets", "fonts"), { recursive: true });
  writeFileSync(path.join(tempDir, "assets", "fonts", "IBM-Plex-Sans-Regular.woff2"), "font-binary");
  writeFileSync(
    path.join(tempDir, "assets", "fonts", "OFL.txt"),
    "SIL OPEN FONT LICENSE Version 1.1\nFont Family: IBM Plex Sans",
    "utf8",
  );

  const initResult = runCli(scriptPath, ["init", "--name", "Evidence Suggest Demo"], { cwd: tempDir });
  assert.equal(initResult.status, 0);

  const addResult = runCli(
    scriptPath,
    [
      "add",
      "--font-id",
      "ibm-plex-sans",
      "--family",
      "IBM Plex Sans",
      "--source",
      "byo",
      "--license-instance-id",
      "lic_plex_001",
      "--active-license-instance-id",
      "lic_plex_001",
    ],
    { cwd: tempDir },
  );
  assert.equal(addResult.status, 0);

  const manifestPath = path.join(tempDir, "LICENSE_MANIFEST.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.license_instances.push({
    kind: "instance",
    license_id: "lic_plex_001",
    licensee_id: manifest.licensees[0].licensee_id,
    offering_ref: { offering_id: "off_plex", offering_version: "1.0.0" },
    scope: { scope_type: "project", scope_id: manifest.project.project_id },
    font_refs: [{ font_id: "ibm-plex-sans", family_name: "IBM Plex Sans" }],
    activated_right_ids: ["media_web"],
    status: "active",
    evidence: [],
    acquisition_source: "legacy",
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const suggestResult = runCli(scriptPath, ["evidence", "suggest", "--path", "."], { cwd: tempDir });
  assert.equal(suggestResult.status, 0);
  const parsed = JSON.parse(suggestResult.stdout);
  assert.equal(parsed.action, "suggest");
  assert.equal(parsed.dry_run, true);
  assert.equal(parsed.suggestions_count, 1);
  assert.equal(parsed.suggestions[0].license_id, "lic_plex_001");
  assert.match(parsed.suggestions[0].path, /OFL\.txt$/);

  const applyResult = runCli(scriptPath, ["evidence", "suggest", "--path", ".", "--apply"], { cwd: tempDir });
  assert.equal(applyResult.status, 0);
  const applied = JSON.parse(applyResult.stdout);
  assert.equal(applied.applied_count, 1);

  const updatedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const updatedInstance = updatedManifest.license_instances.find((entry) => entry.license_id === "lic_plex_001");
  assert.ok(updatedInstance);
  assert.equal(updatedInstance.evidence.length, 1);
  assert.match(updatedInstance.evidence[0].document_path, /OFL\.txt$/);

  rmSync(tempDir, { recursive: true, force: true });
});

test("evidence verify detects missing files in strict mode", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-evidence-verify-"));
  const initResult = runCli(scriptPath, ["init", "--name", "Evidence Verify Demo"], { cwd: tempDir });
  assert.equal(initResult.status, 0);

  const manifestPath = path.join(tempDir, "LICENSE_MANIFEST.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.license_instances.push({
    kind: "instance",
    license_id: "lic_verify_001",
    licensee_id: manifest.licensees[0].licensee_id,
    offering_ref: { offering_id: "off_verify", offering_version: "1.0.0" },
    scope: { scope_type: "project", scope_id: manifest.project.project_id },
    font_refs: [{ font_id: "ghost", family_name: "Ghost" }],
    activated_right_ids: ["media_web"],
    status: "active",
    evidence: [
      {
        evidence_id: "ev_verify_001",
        type: "invoice",
        document_hash: "a".repeat(64),
        document_path: "licenses/missing.pdf",
      },
    ],
    acquisition_source: "legacy",
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const verifyResult = runCli(scriptPath, ["evidence", "verify"], { cwd: tempDir });
  assert.equal(verifyResult.status, 0);
  const parsed = JSON.parse(verifyResult.stdout);
  assert.equal(parsed.action, "verify");
  assert.equal(parsed.summary.missing_file_count, 1);

  const strictResult = runCli(scriptPath, ["evidence", "verify", "--strict"], { cwd: tempDir });
  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(strictResult.status, 2);
});

test("evidence add hashes local license file and attaches it to a license instance", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-evidence-"));
  const licenseFilePath = path.join(tempDir, "licenses", "OFL.txt");
  mkdirSync(path.dirname(licenseFilePath), { recursive: true });
  writeFileSync(
    licenseFilePath,
    "SIL OPEN FONT LICENSE Version 1.1\nCopyright IBM",
    "utf8",
  );

  const initResult = runCli(scriptPath, ["init", "--name", "Evidence Demo"], { cwd: tempDir });
  assert.equal(initResult.status, 0);

  const manifestPath = path.join(tempDir, "LICENSE_MANIFEST.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  manifest.fonts.push({
    font_id: "ibm-plex-sans",
    family_name: "IBM Plex Sans",
    source: { type: "byo" },
    license_instance_ids: ["lic_plex_001"],
    active_license_instance_id: "lic_plex_001",
  });

  manifest.license_instances.push({
    kind: "instance",
    license_id: "lic_plex_001",
    licensee_id: manifest.licensees[0].licensee_id,
    offering_ref: {
      offering_id: "off_plex_web",
      offering_version: "1.0.0",
    },
    scope: {
      scope_type: "project",
      scope_id: manifest.project.project_id,
    },
    font_refs: [
      {
        font_id: "ibm-plex-sans",
        family_name: "IBM Plex Sans",
      },
    ],
    activated_right_ids: ["media_web"],
    status: "active",
    evidence: [],
    acquisition_source: "direct_foundry",
  });

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const evidenceResult = runCli(
    scriptPath,
    ["evidence", "add", "--license-id", "lic_plex_001", "--file", "licenses/OFL.txt"],
    { cwd: tempDir },
  );

  assert.equal(evidenceResult.status, 0);
  const parsed = JSON.parse(evidenceResult.stdout);
  assert.equal(parsed.command, "evidence");
  assert.equal(parsed.action, "add");
  assert.equal(parsed.result.license_id, "lic_plex_001");
  assert.match(parsed.result.evidence.document_hash, /^[A-Fa-f0-9]{64}$/);

  const updatedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const updatedInstance = updatedManifest.license_instances.find(
    (entry) => entry.license_id === "lic_plex_001",
  );
  assert.ok(updatedInstance);
  assert.equal(updatedInstance.evidence.length, 1);
  assert.equal(updatedInstance.evidence[0].document_name, "OFL.txt");

  rmSync(tempDir, { recursive: true, force: true });
});

test("migrate dry-run reports no-op when manifest is current", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-migrate-dry-"));
  const initResult = runCli(scriptPath, ["init", "--name", "Migrate Dry Demo"], { cwd: tempDir });
  assert.equal(initResult.status, 0);

  const migrateResult = runCli(scriptPath, ["migrate"], { cwd: tempDir });
  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(migrateResult.status, 0);
  const parsed = JSON.parse(migrateResult.stdout);
  assert.equal(parsed.command, "migrate");
  assert.equal(parsed.migration.dry_run, true);
  assert.equal(parsed.migration.no_op, true);
});

test("migrate --apply upgrades manifest version and writes backup", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-migrate-apply-"));
  const initResult = runCli(scriptPath, ["init", "--name", "Migrate Apply Demo"], { cwd: tempDir });
  assert.equal(initResult.status, 0);

  const manifestPath = path.join(tempDir, "LICENSE_MANIFEST.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.manifest_version = "0.9.0";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const migrateResult = runCli(scriptPath, ["migrate", "--apply"], { cwd: tempDir });
  assert.equal(migrateResult.status, 0);

  const parsed = JSON.parse(migrateResult.stdout);
  assert.equal(parsed.migration.applied, true);
  assert.equal(typeof parsed.migration.backup_path, "string");
  assert.equal(parsed.migration.backup_path.length > 0, true);

  const migratedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(migratedManifest.manifest_version, "1.0.0");
  assert.equal(parsed.migration.backup_path.endsWith(".json"), true);

  rmSync(tempDir, { recursive: true, force: true });
});

test("runs through symlinked entrypoint (npm bin-style execution)", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-link-"));
  const linkedScriptPath = path.join(tempDir, "setzkasten");

  symlinkSync(scriptPath, linkedScriptPath);

  const result = runCli(linkedScriptPath, ["--help"]);

  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Setzkasten CLI \(V1\)/);
});
