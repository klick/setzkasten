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

test("runs through symlinked entrypoint (npm bin-style execution)", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-link-"));
  const linkedScriptPath = path.join(tempDir, "setzkasten");

  symlinkSync(scriptPath, linkedScriptPath);

  const result = runCli(linkedScriptPath, ["--help"]);

  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Setzkasten CLI \(V1\)/);
});
