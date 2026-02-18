# Lizenzschema (Konzept) – v1.0.0

Dieses Dokument beschreibt Semantik und Modell. JSON Schema liegt in `contracts/license-spec/schema.json`.

## Begriffe
- **License Offering**: Abstraktes Lizenzpaket (versioniert), inkl. Rechte, Metrikmodelle, Preisformel, Upgrade-Pfade.
- **License Instance**: Konkrete Instanz (immutable), die eine Offering-Version auf einen Lizenznehmer und Scope anwendet.

## Design-Prinzipien
- Rechte (qualitativ) und Metriken (quantitativ) sind getrennt.
- Nutzung (Runtime) ist getrennt von Vertrag (Instance).
- Upgrades erzeugen neue Instances (`upgrades_from`), keine Mutation.
- Evidence ist strukturiert, mehrere Evidence-Objekte sind möglich.
- IDs sind stabil und maschinenlesbar (`font_id`, `offering_id`, `license_id`).

## License Offering – Kernfelder
- `offering_id` (stabil)
- `offering_version` (semver)
- `offering_type` (commercial | trial)
- `rights[]` (inkl. Distribution/Hosting, Modifikationen, Client Work, Redistribution, Allowed Formats)
- `metric_models[]` (z. B. seats, installs, print_run, pageviews optional)
- `price_formula` (deterministisch, datengetrieben)
- `upgrade_paths[]` (explizite, erlaubte Upgrades)

## License Instance – Kernfelder
- `license_id` (stabil)
- `licensee_id` (juristische Entität; generischer `licensee` mit `type`)
- `offering_ref` (id + version)
- `scope` (scope_type + scope_id + optional domains)
- `font_refs[]` (Familie + optional Styles)
- `activated_right_ids[]` (Teilaktivierung möglich)
- `metric_limits[]` (konkrete Auswahl für diese Instanz)
- `status` (active | expired | superseded | revoked)
- `valid_from` / `valid_until` (Term-Lizenzen möglich)
- `evidence[]` (mindestens 1; inkl. Dokument-Hash)
- `acquisition_source` (direct_foundry | reseller | marketplace | legacy)
- `upgrades_from` (optional)

## Normalformen
- Scripts/Sprachen: normalisiert (z. B. ISO/Unicode-basierte Tags).
- OpenType Features: 4-char Tags (z. B. liga, kern).
- Variable Achsen: Tags (z. B. wght, wdth).

## Nicht modelliert in V1
- Attribution/Imprint-Pflichten.
