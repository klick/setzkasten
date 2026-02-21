# V1 Feature Set (Final Cut)

Goal: developer workflow for lawful, auditable font usage in projects.

## In Scope (V1)
### CLI Commands
- `setzkasten init`
  - creates `LICENSE_MANIFEST.json`
  - creates `.setzkasten/events.log` (NDJSON)
- `setzkasten add`
  - adds a font entry (OSS or BYO)
  - updates manifest + event log
- `setzkasten remove`
  - removes a font entry
  - writes an event log entry
- `setzkasten scan`
  - local repository scan
  - optional discovery of font binaries and font-adjacent license files
  - dependency directories (`node_modules`, `vendor`) ignored by default
  - deterministic file fingerprint (`document_hash`) for discovered license files
  - domain scan only after domain verification (interface prepared)
- `setzkasten evidence add`
  - attach/update evidence for an existing `license_instance` from a local file
  - store hash + metadata in manifest (not file contents)
- `setzkasten policy`
  - policy evaluation: `allow` / `warn` / `escalate`
- `setzkasten quote`
  - deterministic quote calculation based on the license schema
- `setzkasten migrate`
  - migration scaffold for manifest and license schema

### Data Models
- Manifest (source of truth)
- License schema v1.0.0 (offering + instance)
- Event log (append-only)
- Evidence workflow: discover -> hash -> link -> policy

### Telemetry
- Optional, opt-in, anonymized (product improvement only)
- Default: off

## Out of Scope (V1)
- Marketplace / checkout / payment
- Hosting or distribution of proprietary font files
- Proprietary font preview
- Role model (`owner`/`approver`) and approval flows
- Order state machine (`intent`/`approval`/`capture`)
- Automatic usage measurement (traffic/seats)
- Public standardization of the license schema
