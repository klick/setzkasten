# Policy Rules – v1.0.0 (minimal)

Policy Engine liefert:
- `allow`
- `warn`
- `escalate`

## Beispiele für Regeln
- warn: BYO-Font ohne Evidence
- warn: aktivierte Rechte enthalten Self-Hosting, aber Offering erlaubt nur CDN
- escalate: License Instance status != active
- escalate: Modifikation (subset/convert) notwendig, aber nicht erlaubt
- warn: Domain im Manifest nicht im Scope der License Instance

## Ausgabeformat
- `decision`: allow|warn|escalate
- `reasons[]`: maschinenlesbare Codes + human-readable message
- `evidence_required[]`: welche Felder fehlen (z. B. invoice_number)
