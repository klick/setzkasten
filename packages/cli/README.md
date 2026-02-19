# @setzkasten/cli

CLI-first tool for font license governance, audit logging, and deterministic policy/quote checks.

## What it does (V1)
- Initializes a project manifest (`LICENSE_MANIFEST.json`)
- Writes an append-only event log (`.setzkasten/events.log`)
- Adds/removes font entries
- Scans controlled local assets for usage signals
- Evaluates policy decisions (`allow`, `warn`, `escalate`)
- Generates deterministic quote output
- Provides a migration stub command

## Install
```bash
npm install -g @setzkasten/cli
```

## Usage
```bash
setzkasten init --name "My Project"
setzkasten add --font-id inter --family "Inter" --source oss
setzkasten scan --path .
setzkasten policy
setzkasten quote
setzkasten migrate
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
