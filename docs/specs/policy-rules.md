# Policy Rules - v1.0.0 (Minimal)

Policy engine outputs:
- `allow`
- `warn`
- `escalate`

## Example Rules
- `warn`: BYO font without evidence
- `warn`: activated rights include self-hosting, but offering allows CDN only
- `escalate`: license instance `status != active`
- `escalate`: modification required (`subset`/`convert`) but not allowed
- `warn`: manifest domain is out of license instance scope

## Output Format
- `decision`: `allow` | `warn` | `escalate`
- `reasons[]`: machine-readable codes + human-readable message
- `evidence_required[]`: missing fields (for example `invoice_number`)
