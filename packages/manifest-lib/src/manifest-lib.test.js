import test from "node:test";
import assert from "node:assert/strict";
import {
  addFontToManifest,
  createManifest,
  removeFontFromManifest,
  upsertLicenseEvidence,
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

test("upsertLicenseEvidence attaches evidence to an existing license instance", async () => {
  const manifest = createManifest({
    projectName: "Evidence Project",
  });

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

  const validationBefore = await validateManifestDocument(manifest);
  assert.equal(validationBefore.valid, true);

  const result = upsertLicenseEvidence(manifest, {
    licenseId: "lic_plex_001",
    documentHash: "91c25c350d3cac39da2736d74f7ba37ef648f5237a4e330a240615bc8d8c4360",
    documentName: "OFL.txt",
    type: "other",
  });

  assert.equal(result.action, "added");
  assert.equal(result.license_id, "lic_plex_001");
  assert.equal(result.evidence.document_name, "OFL.txt");

  const validationAfter = await validateManifestDocument(result.manifest);
  assert.equal(validationAfter.valid, true);
  assert.equal(result.manifest.license_instances[0].evidence.length, 1);
});
