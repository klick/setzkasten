# V1 Feature Set (Final Cut)

Ziel: Developer-Workflow für legale, auditierbare Font-Nutzung im Projekt.

## In Scope (V1)
### CLI Commands
- `setzkasten init`
  - erzeugt `LICENSE_MANIFEST.json`
  - erzeugt `.setzkasten/events.log` (NDJSON)
- `setzkasten add`
  - fügt einen Font-Eintrag hinzu (OSS oder BYO)
  - aktualisiert Manifest + Event-Log
- `setzkasten remove`
  - entfernt einen Font-Eintrag
  - Event-Log Eintrag
- `setzkasten scan`
  - Repo-Scan (lokal)
  - Domain-Scan nur nach Domain-Verifikation (Interface vorbereitet)
- `setzkasten policy`
  - Policy Evaluation: allow / warn / escalate
- `setzkasten quote`
  - deterministische Quote-Berechnung auf Basis des Lizenzschemas
- `setzkasten migrate`
  - Migrationsgerüst für Manifest und Lizenzschema

### Datenmodelle
- Manifest (Source of Truth)
- Lizenzschema v1.0.0 (Offering + Instance)
- Event-Log (append-only)

### Telemetrie
- optional, opt-in, anonymisiert (nur für Produkt-Verbesserung)
- Default: off

## Out of Scope (V1)
- Marketplace / Checkout / Payment
- Hosting oder Auslieferung proprietärer Font-Dateien
- Proprietäres Font-Preview
- Rollenmodell (Owner/Approver) und Approval-Flows
- Order-State-Machine (Intent/Approval/Capture)
- automatische Nutzungsmessung (Traffic/Seats)
- öffentliche Standardisierung des Lizenzschemas
