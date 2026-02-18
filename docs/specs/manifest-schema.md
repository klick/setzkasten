# Manifest Schema (Konzept) – v1.0.0

JSON Schema liegt in `contracts/manifest/schema.json`.

## Ziel
- Projekt ist Source of Truth.
- Manifest ist commitbar, diffbar, auditierbar.
- Keine geheimen Server-States.

## Struktur (high-level)
- `manifest_version`
- `project` (id, name, repo, domains)
- `licensees[]`
- `fonts[]` (Nutzung + Quelle)
- `license_offerings[]` (optional, lokal)
- `license_instances[]` (lokal, referenziert von Fonts)
