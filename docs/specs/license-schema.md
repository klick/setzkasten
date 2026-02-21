# License Schema (Concept) - v1.0.0

This document defines semantics and the model. The JSON Schema lives in `contracts/license-spec/schema.json`.

## Terms
- **License Offering**: Abstract license package (versioned), including rights, metric models, price formula, and upgrade paths.
- **License Instance**: Concrete immutable instance that applies one offering version to a licensee and scope.

## Design Principles
- Rights (qualitative) and metrics (quantitative) are separate.
- Usage (runtime) is separate from contract (instance).
- Upgrades create new instances (`upgrades_from`), no mutation.
- Evidence is structured; multiple evidence objects are allowed.
- IDs are stable and machine-readable (`font_id`, `offering_id`, `license_id`).

## License Offering - Core Fields
- `offering_id` (stable)
- `offering_version` (semver)
- `offering_type` (`commercial` | `trial`)
- `rights[]` (including distribution/hosting, modifications, client work, redistribution, allowed formats)
- `metric_models[]` (for example `seats`, `installs`, `print_run`, optional `pageviews`)
- `price_formula` (deterministic, data-driven)
- `upgrade_paths[]` (explicit allowed upgrades)

## License Instance - Core Fields
- `license_id` (stable)
- `licensee_id` (legal entity; generic `licensee` with `type`)
- `offering_ref` (id + version)
- `scope` (`scope_type` + `scope_id` + optional domains)
- `font_refs[]` (family + optional styles)
- `activated_right_ids[]` (partial activation allowed)
- `metric_limits[]` (concrete selection for this instance)
- `status` (`active` | `expired` | `superseded` | `revoked`)
- `valid_from` / `valid_until` (term licenses supported)
- `evidence[]` (hash + metadata references; can start empty and be attached later)
- `acquisition_source` (`direct_foundry` | `reseller` | `marketplace` | `legacy`)
- `upgrades_from` (optional)

## Normal Forms
- Scripts/languages are normalized (for example ISO/Unicode-based tags).
- OpenType features use 4-character tags (for example `liga`, `kern`).
- Variable axes use tags (for example `wght`, `wdth`).

## Not Modeled in V1
- Attribution/imprint obligations.
