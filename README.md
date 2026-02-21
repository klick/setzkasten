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
setzkasten evidence add --license-id lic_inter_001 --file ./licenses/OFL.txt
setzkasten policy
setzkasten quote
```

## Quick Start (Repository Source)
```bash
npm run build
node packages/cli/src/index.js init
node packages/cli/src/index.js add --font-id inter --family "Inter" --source oss
node packages/cli/src/index.js scan --discover
node packages/cli/src/index.js evidence add --license-id lic_inter_001 --file ./licenses/OFL.txt
node packages/cli/src/index.js policy
node packages/cli/src/index.js quote
```

## CLI V1
- `init`
- `add`
- `remove`
- `scan`
- `evidence add`
- `policy`
- `quote`
- `migrate` (stub)

## License Workflow
- `scan --discover` finds font files and font-adjacent license files in the repository.
- Root scans ignore dependency directories like `node_modules` and `vendor` by default.
- Discovered license files include a deterministic `document_hash` (sha256) in CLI output.
- `evidence add` links a local license document hash to a `license_instance`.
- `policy` warns when BYO fonts have no linked license instance or no evidence.

## Documentation
- V1 feature cut: `docs/specs/v1-feature-set.md`
- Policy rules: `docs/specs/policy-rules.md`
- Event log: `docs/specs/event-log.md`
- Manifest schema (concept): `docs/specs/manifest-schema.md`
- License schema (concept): `docs/specs/license-schema.md`
- JSON schemas: `contracts/`

## License
See `LICENSE`.
