# Event Log (NDJSON) - v1.0.0

File: `.setzkasten/events.log` (append-only, NDJSON)

## Goals
- Auditability and debuggability.
- Foundation for later orders/approvals without model breaks.

## Event Form
Each event is one JSON object per line.

Required fields:
- `event_id` (UUID)
- `event_type` (string)
- `ts` (ISO 8601)
- `actor` (string, for example `local_user`)
- `project_id`
- `schema_versions` (`manifest`, `license_spec`)
- `payload` (object)
- `payload_hash` (sha256 over canonical JSON)

## Minimal Event Catalog (V1)
- `manifest.created`
- `manifest.font_added`
- `manifest.font_removed`
- `manifest.license_ref_added` (evidence hash linked or updated for a license instance)
- `scan.completed`
- `policy.ok`
- `policy.warning_raised`
- `quote.generated`
- `migration.planned` (stub)

`scan.completed` payload should include:
- `discovered_font_files_count`
- `discovered_license_files_count`
- `discover_enabled`
