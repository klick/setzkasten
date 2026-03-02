# Setzkasten License Guard Action

Run Setzkasten policy checks in GitHub Actions.

## Inputs
- `manifest_path` (default: `LICENSE_MANIFEST.json`)
- `working_directory` (default: `.`)
- `fail_on` (`warn` or `escalate`, default: `escalate`)
- `format` (`json`, `sarif`, `junit`, default: `json`)

## Outputs
- `exit_code`
- `policy_decision`

## Example
```yaml
name: license-guard
on:
  pull_request:

jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: klick/setzkasten/integrations/github-action-license-guard@main
        with:
          manifest_path: LICENSE_MANIFEST.json
          fail_on: escalate
```
