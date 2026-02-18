# Event Log (NDJSON) – v1.0.0

Datei: `.setzkasten/events.log` (append-only, NDJSON)

## Ziele
- Auditierbarkeit und Debuggability.
- Grundlage für spätere Orders/Approvals ohne Modellbruch.

## Event Form
Jedes Event ist ein JSON-Objekt pro Zeile.

Pflichtfelder:
- `event_id` (UUID)
- `event_type` (string)
- `ts` (ISO 8601)
- `actor` (string, z. B. local_user)
- `project_id`
- `schema_versions` (manifest, license_spec)
- `payload` (object)
- `payload_hash` (sha256 über canonical JSON)

## Minimaler Event-Katalog (V1)
- `manifest.created`
- `manifest.font_added`
- `manifest.font_removed`
- `manifest.license_ref_added`
- `scan.completed`
- `policy.ok`
- `policy.warning_raised`
- `quote.generated`
- `migration.planned` (Stub)
