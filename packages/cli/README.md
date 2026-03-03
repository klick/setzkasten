# @setzkasten/cli

CLI-first tool for font license governance, audit logging, and deterministic policy/quote checks.

## Positioning
- Agencies: keep client font-license trails verifiable without slowing delivery.
- Product teams: move license checks into CI and catch gaps during pull requests.
- Enterprise/compliance: get deterministic evidence and audit-ready usage history at scale.

## What it does (V1)
- Initializes a project manifest (`LICENSE_MANIFEST.json`)
- Writes an append-only event log (`.setzkasten/events.log`)
- Adds/removes font entries
- Imports font entries from discovered local font files
- Scans controlled local assets for usage signals
- Discovers likely license files and computes deterministic `document_hash` values
- Links license evidence files to existing license instances (`evidence add`)
- Evaluates policy decisions (`allow`, `warn`, `escalate`)
- Supports policy presets: `strict`, `startup`, `enterprise`
- Emits `json`, `sarif`, or `junit` output for `scan` and `policy`
- Generates deterministic quote output
- Provides dry-run/apply migration with manifest backup support

## Install
```bash
npm install -g @setzkasten/cli
```

## Usage
```bash
setzkasten init --name "My Project"
setzkasten import --path . --apply
setzkasten add --font-id inter --family "Inter" --source oss
setzkasten scan --path . --discover
setzkasten doctor --strict
setzkasten evidence suggest --path . --apply
setzkasten evidence verify --strict
setzkasten evidence add --license-id lic_inter_001 --file ./licenses/OFL.txt
setzkasten exception add --code BYO_NO_EVIDENCE --font-id inter --reason "Temporary waiver"
setzkasten report --format markdown --output compliance-report.md
setzkasten sync export
setzkasten policy
setzkasten quote
setzkasten migrate --apply
setzkasten migrate
```

## License Evidence Workflow
Bootstrap manifest entries from discovered font files:
```bash
setzkasten import --path .
setzkasten import --path . --apply
```

1. Run `setzkasten scan --path . --discover` to list discovered fonts and font-adjacent license files.
2. Review `result.discovered_license_files` in JSON output (`path`, `document_hash`, `detected_license`, `matched_font_ids`).
3. Optional automatic suggestions:
```bash
setzkasten evidence suggest --path .
setzkasten evidence suggest --path . --apply
```
3. Link the local license file to a license instance:
```bash
setzkasten evidence add --license-id <license_id> --file <path-to-license-file>
```
4. Verify evidence file paths and hash integrity:
```bash
setzkasten evidence verify
setzkasten evidence verify --strict
```
5. Run `setzkasten policy` to verify BYO evidence state.

## Policy Exceptions
Create time-bound waivers for specific policy codes:
```bash
setzkasten exception add --code BYO_NO_EVIDENCE --font-id inter --reason "Temporary waiver"
setzkasten exception list
setzkasten exception remove --exception-id <exception_id>
```

## Reporting
Generate a governance snapshot in JSON or Markdown:
```bash
setzkasten report --format json
setzkasten report --format markdown --output compliance-report.md
```

## Sync Snapshot
Export a stable local snapshot for dashboard/API consumers:
```bash
setzkasten sync export
setzkasten sync export --output .setzkasten/sync/project-a.json
```

Dependency directories such as `node_modules` and `vendor` are ignored during scans by default.

## Doctor
Run environment and governance diagnostics:

```bash
setzkasten doctor
setzkasten doctor --strict
```

## Data written locally
- `LICENSE_MANIFEST.json`
- `.setzkasten/events.log`

## Constraints (V1)
- No proprietary font hosting/distribution
- No proprietary font preview
- No general web crawling
- Offline-first core behavior
- Not legal advice
