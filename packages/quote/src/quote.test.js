import test from "node:test";
import assert from "node:assert/strict";
import { generateQuote } from "./index.js";

function quoteFixture() {
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
    fonts: [],
    license_offerings: [
      {
        kind: "offering",
        offering_id: "off_1",
        offering_version: "1.0.0",
        offering_type: "commercial",
        name: "Web Commercial",
        rights: [{ right_id: "r1", right_type: "media_web", allowed: true }],
        metric_models: [],
        price_formula: {
          currency: "EUR",
          base_price: 100,
          rules: [
            {
              when: {
                metric_type: "seats",
                period: "per_year",
                gte: 10,
              },
              multiplier: 1.5,
              add: 20,
            },
          ],
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
        },
        font_refs: [{ font_id: "font_1", family_name: "Inter" }],
        activated_right_ids: ["r1"],
        metric_limits: [
          {
            metric_type: "seats",
            limit: 20,
            period: "per_year",
          },
        ],
        status: "active",
        evidence: [{ evidence_id: "ev_1", type: "invoice", document_hash: "a".repeat(64) }],
        acquisition_source: "legacy",
      },
    ],
  };
}

test("generateQuote applies deterministic pricing rules", () => {
  const manifest = quoteFixture();
  const quote = generateQuote(manifest);

  assert.equal(quote.line_items.length, 1);
  assert.equal(quote.line_items[0].amount, 170);
  assert.equal(quote.totals.EUR, 170);
});

test("generateQuote is deterministic for same input", () => {
  const manifest = quoteFixture();

  const first = generateQuote(manifest);
  const second = generateQuote(manifest);

  assert.equal(first.deterministic_hash, second.deterministic_hash);
  assert.deepEqual(first.line_items, second.line_items);
  assert.deepEqual(first.totals, second.totals);
});

test("generateQuote skips inactive license instances", () => {
  const manifest = quoteFixture();
  manifest.license_instances[0].status = "expired";

  const quote = generateQuote(manifest);

  assert.equal(quote.line_items.length, 0);
  assert.equal(quote.totals.EUR, undefined);
  assert.ok(quote.skipped.some((entry) => entry.includes("status=expired")));
});
