# Setzkasten

Setzkasten ist ein CLI-first Tool für Fonts, Lizenzen und Nachweisführung im Projekt.
Fokus V1: Ordnung, Auditierbarkeit, Policies, deterministische Quotes. Kein Marketplace.

## V1 Grenzen
- Nur Open-Source-Fonts und „Bring your own font“ (BYO).
- Kein Hosting oder Ausliefern proprietärer Font-Dateien.
- Kein proprietäres Font-Preview.
- Scans nur für kontrollierte Assets (Repo-Zugriff / Domain-Verifikation).
- Keine Rechtsberatung.

## Schnellstart (geplant)
```bash
npm install
npm run build
node packages/cli/dist/index.js init
```

## Dokumentation
- Entscheidungen: `docs/adr/000-project-foundations.md`
- V1 Feature Cut: `docs/specs/v1-feature-set.md`
- Lizenzschema (Konzept): `docs/specs/license-schema.md`
- JSON Schemas: `contracts/`

## Lizenz
Siehe `LICENSE`.
