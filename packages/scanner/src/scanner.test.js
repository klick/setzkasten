import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanProject } from "./index.js";

function baseManifest() {
  return {
    manifest_version: "1.0.0",
    project: {
      project_id: "proj_1",
      name: "Project 1",
    },
    licensees: [
      {
        licensee_id: "proj_1.owner",
        type: "organization",
        legal_name: "Project 1",
      },
    ],
    fonts: [
      {
        font_id: "inter",
        family_name: "Inter",
        source: { type: "oss" },
        license_instance_ids: [],
      },
    ],
    license_instances: [],
  };
}

test("scanProject discovers font files when discover=true", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-scanner-"));

  mkdirSync(path.join(tempDir, "assets", "fonts"), { recursive: true });
  writeFileSync(path.join(tempDir, "assets", "fonts", "Inter-Regular.woff2"), "font-binary");
  writeFileSync(path.join(tempDir, "assets", "fonts", "Real-Bold.otf"), "font-binary");
  writeFileSync(
    path.join(tempDir, "styles.css"),
    "body { font-family: 'Inter', sans-serif; }",
    "utf8",
  );

  const result = await scanProject({
    rootPath: tempDir,
    manifest: baseManifest(),
    discover: true,
  });

  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(result.scanned_files_count, 1);
  assert.equal(result.font_matches.inter.match_count, 1);
  assert.equal(result.discovered_font_files.length, 2);

  const inter = result.discovered_font_files.find((entry) => entry.file_name === "Inter-Regular.woff2");
  assert.ok(inter);
  assert.equal(inter.family_guess, "Inter");
  assert.equal(inter.font_id_guess, "inter");
});

test("scanProject does not include discovered files when discover=false", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-scanner-"));
  mkdirSync(path.join(tempDir, "fonts"), { recursive: true });
  writeFileSync(path.join(tempDir, "fonts", "Inter-Regular.woff2"), "font-binary");

  const result = await scanProject({
    rootPath: tempDir,
    manifest: baseManifest(),
    discover: false,
  });

  rmSync(tempDir, { recursive: true, force: true });

  assert.deepEqual(result.discovered_font_files, []);
});
