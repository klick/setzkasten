# Setzkasten

Setzkasten is a CLI-first tool for font license governance, auditability, and deterministic policy and quote checks.
V1 focuses on reliable project records and offline-first workflows. There is no marketplace in V1.

## V1 Boundaries
- Open-source fonts and BYO (bring your own fonts) only.
- No hosting or distribution of proprietary font files.
- No proprietary font preview.
- Scans only controlled assets (local repositories or verified-domain workflows).
- Not legal advice.

## Install
```bash
npm install -g @setzkasten/cli
```

## Quick Start (Global Install)
```bash
setzkasten init --name "My Project"
setzkasten add --font-id inter --family "Inter" --source oss
setzkasten scan --path . --discover
setzkasten policy
setzkasten quote
```

## Quick Start (Repository Source)
```bash
npm run build
node packages/cli/src/index.js init
node packages/cli/src/index.js add --font-id inter --family "Inter" --source oss
node packages/cli/src/index.js scan
node packages/cli/src/index.js policy
node packages/cli/src/index.js quote
```

## CLI V1
- `init`
- `add`
- `remove`
- `scan`
- `policy`
- `quote`
- `migrate` (stub)

## Documentation
- Decisions: `docs/adr/000-project-foundations.md`
- V1 feature cut: `docs/specs/v1-feature-set.md`
- License schema (concept): `docs/specs/license-schema.md`
- JSON Schemas: `contracts/`

## License
See `LICENSE`.
