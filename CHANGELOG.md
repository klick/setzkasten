# Changelog

## Unreleased

## 0.1.0-rc.7 - 2026-02-22
- Added new `prune` command for manifest-only cleanup of stale font entries.
- `prune` defaults to dry-run and supports `--apply`, `--rule`, and `--max-removals`.
- Default prune rule removes fonts only when both conditions are true: no discovered font file and no usage matches.
- Applying prune now removes orphaned linked license instances that are no longer referenced by remaining fonts.
- Added new event types: `manifest.font_pruned`, `manifest.license_instance_pruned`, and `prune.completed`.
- Added CLI integration tests for prune dry-run and apply flows.
- Updated README and specs to document prune workflow.

## 0.1.0-rc.6 - 2026-02-21
- Focused `scan --discover` on font-relevant results by restricting discovered license files to font-adjacent paths.
- Added default ignore rules for dependency directories (`vendor`, `bower_components`) in scanner traversal.
- Reduced false positives for font matching via token-based family-name matching (e.g. avoids matching `Inter` inside `interface`).
- Added regression tests for root-level license noise filtering and substring-match prevention.
- Updated CLI help and docs to explain font-adjacent discovery behavior.

## 0.1.0-rc.3 - 2026-02-19
- Added `scan --discover` to find existing local font files (`.woff2`, `.woff`, `.ttf`, `.otf`, `.otc`).
- Added discovery result output with path, extension, file name, family guess, and font ID guess.
- Added scanner package regression tests for discovery behavior.
- Added CLI integration test for `scan --discover`.

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
