import test from "node:test";
import assert from "node:assert/strict";
import { applyPolicyPreset, evaluatePolicy } from "./index.js";

function baseManifest() {
  return {
    manifest_version: "1.0.0",
    project: {
      project_id: "proj_1",
      name: "Project 1",
      domains: ["example.com"],
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
        font_id: "font_1",
        family_name: "Inter",
        source: { type: "byo" },
        license_instance_ids: ["lic_1"],
      },
    ],
    license_offerings: [
      {
        kind: "offering",
        offering_id: "off_1",
        offering_version: "1.0.0",
        offering_type: "commercial",
        name: "Commercial",
        rights: [
          { right_id: "r1", right_type: "distribution_cdn_hosting", allowed: true },
          { right_id: "r2", right_type: "distribution_self_hosting", allowed: false },
          {
            right_id: "r3",
            right_type: "modification",
            allowed: true,
            modification_kinds: ["subset"],
          },
        ],
        metric_models: [],
        price_formula: {
          currency: "EUR",
          base_price: 10,
        },
      },
    ],
    license_instances: [
      {
        kind: "instance",
        license_id: "lic_1",
        licensee_id: "proj_1.owner",
        offering_ref: {
          offering_id: "off_1",
          offering_version: "1.0.0",
        },
        scope: {
          scope_type: "project",
          scope_id: "proj_1",
          domains: ["example.com"],
        },
        font_refs: [{ font_id: "font_1", family_name: "Inter" }],
        activated_right_ids: ["r1"],
        status: "active",
        evidence: [{ evidence_id: "ev_1", type: "invoice", document_hash: "a".repeat(64) }],
        acquisition_source: "legacy",
      },
    ],
  };
}

test("warns when BYO evidence is missing", () => {
  const manifest = baseManifest();
  manifest.license_instances[0].evidence = [];

  const result = evaluatePolicy(manifest);

  assert.equal(result.decision, "warn");
  assert.ok(result.reasons.some((reason) => reason.code === "BYO_NO_EVIDENCE"));
  assert.ok(result.evidence_required.includes("license_instances[].evidence[]"));
});

test("escalates when license status is not active", () => {
  const manifest = baseManifest();
  manifest.license_instances[0].status = "expired";

  const result = evaluatePolicy(manifest);

  assert.equal(result.decision, "escalate");
  assert.ok(result.reasons.some((reason) => reason.code === "LICENSE_STATUS_NOT_ACTIVE"));
});

test("escalates when required modification kind is not allowed", () => {
  const manifest = baseManifest();
  manifest.fonts[0].usage = { required_modifications: ["convert"] };

  const result = evaluatePolicy(manifest);

  assert.equal(result.decision, "escalate");
  assert.ok(result.reasons.some((reason) => reason.code === "MODIFICATION_KIND_NOT_ALLOWED"));
});

test("returns allow when no policy findings are present", () => {
  const manifest = baseManifest();
  manifest.fonts[0].source = { type: "oss" };

  const result = evaluatePolicy(manifest);

  assert.equal(result.decision, "allow");
  assert.equal(result.reasons.length, 0);
});

test("strict preset escalates warnings", () => {
  const manifest = baseManifest();
  manifest.license_instances[0].evidence = [];

  const result = evaluatePolicy(manifest);
  const strict = applyPolicyPreset(result, "strict");

  assert.equal(result.decision, "warn");
  assert.equal(strict.decision, "escalate");
  assert.equal(strict.preset_applied, "strict");
  assert.equal(strict.reasons.some((reason) => reason.severity === "escalate"), true);
});

test("startup preset suppresses domain-out-of-scope warnings", () => {
  const manifest = baseManifest();
  manifest.project.domains = ["example.com", "outside.example"];
  manifest.license_instances[0].scope.domains = ["example.com"];

  const result = evaluatePolicy(manifest);
  const startup = applyPolicyPreset(result, "startup");

  assert.equal(result.reasons.some((reason) => reason.code === "DOMAIN_OUT_OF_SCOPE"), true);
  assert.equal(startup.reasons.some((reason) => reason.code === "DOMAIN_OUT_OF_SCOPE"), false);
  assert.equal(startup.preset_applied, "startup");
});

test("policy exceptions suppress matching reasons", () => {
  const manifest = baseManifest();
  manifest.license_instances[0].evidence = [];
  manifest.policy_exceptions = [
    {
      exception_id: "exc_byo_evidence",
      code: "BYO_NO_EVIDENCE",
      font_id: "font_1",
      reason: "Temporary waiver",
    },
  ];

  const result = evaluatePolicy(manifest);

  assert.equal(result.decision, "allow");
  assert.equal(result.reasons.some((reason) => reason.code === "BYO_NO_EVIDENCE"), false);
  assert.equal(result.suppressed_reasons.some((reason) => reason.code === "BYO_NO_EVIDENCE"), true);
  assert.equal(result.active_exception_ids.includes("exc_byo_evidence"), true);
});

test("expired policy exceptions do not suppress findings", () => {
  const manifest = baseManifest();
  manifest.license_instances[0].evidence = [];
  manifest.policy_exceptions = [
    {
      exception_id: "exc_expired",
      code: "BYO_NO_EVIDENCE",
      font_id: "font_1",
      expires_at: "2000-01-01T00:00:00.000Z",
    },
  ];

  const result = evaluatePolicy(manifest);

  assert.equal(result.decision, "warn");
  assert.equal(result.reasons.some((reason) => reason.code === "BYO_NO_EVIDENCE"), true);
  assert.equal(result.suppressed_reasons.length, 0);
});
