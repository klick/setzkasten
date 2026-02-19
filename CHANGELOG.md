# Changelog

## Unreleased
- No changes yet.

## 0.1.0-rc.2 - 2026-02-19
- Fixed CLI silent no-op when executed via npm/local symlinked bin (`npx setzkasten ...`).
- Added regression test for symlink/bin-style invocation in CLI package.

## 0.1.0-rc.1 - 2026-02-19
- Implemented V1 CLI command set: `init`, `add`, `remove`, `scan`, `policy`, `quote`, `migrate` (stub).
- Added local project state contracts:
  - `LICENSE_MANIFEST.json` as source of truth
  - `.setzkasten/events.log` as append-only NDJSON event stream
- Added schema-aware manifest/license validation and contract example checks.
- Added policy engine (`allow`, `warn`, `escalate`) with reason/evidence output.
- Added deterministic quote engine with stable output hash.
- Added local controlled-asset scanner (offline-first, no implicit network calls).
- Added publish-ready `@setzkasten/cli` package metadata and package file whitelist.
- Added packaging guardrails to prevent private files (`AGENTS.md`, `__meta`, tests) from distribution.
- Added release scripts and `release:cli:check` verification workflow.
