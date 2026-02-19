import test from "node:test";
import assert from "node:assert/strict";
import {
  addFontToManifest,
  createManifest,
  removeFontFromManifest,
  validateManifestDocument,
} from "./index.js";

test("createManifest produces schema-valid manifest", async () => {
  const manifest = createManifest({
    projectName: "Acme Design",
    projectId: "acme_design",
    licenseeLegalName: "Acme Design GmbH",
    projectDomains: ["acme.example"],
  });

  const validation = await validateManifestDocument(manifest);

  assert.equal(validation.valid, true);
  assert.equal(validation.errors.length, 0);
});

test("validateManifestDocument rejects invalid manifest", async () => {
  const invalidManifest = {
    manifest_version: "1.0.0",
    project: {
      project_id: "proj_1",
      name: "Project",
    },
    fonts: [],
    license_instances: [],
  };

  const validation = await validateManifestDocument(invalidManifest);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.length > 0);
});

test("addFontToManifest and removeFontFromManifest update manifest entries", async () => {
  const manifest = createManifest({
    projectName: "Font Project",
  });

  const withFont = addFontToManifest(manifest, {
    font_id: "font_inter",
    family_name: "Inter",
    source: { type: "oss" },
    license_instance_ids: [],
  });

  const validationAfterAdd = await validateManifestDocument(withFont);
  assert.equal(validationAfterAdd.valid, true);

  const removed = removeFontFromManifest(withFont, "font_inter");
  assert.equal(removed.removed, true);

  const fonts = removed.manifest.fonts;
  assert.equal(fonts.length, 0);
});
