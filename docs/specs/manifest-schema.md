# Manifest Schema (Concept) - v1.0.0

The JSON Schema lives in `contracts/manifest/schema.json`.

## Goal
- The project is the source of truth.
- The manifest is committable, diffable, and auditable.
- No hidden server-side state.

## Structure (High Level)
- `manifest_version`
- `project` (`id`, `name`, `repo`, `domains`)
- `licensees[]`
- `fonts[]` (usage + source)
- `license_offerings[]` (optional, local)
- `license_instances[]` (local, referenced by fonts)
