# Usage Interface (V1: Contract only)

V1 misst keine Nutzung. Es wird nur definiert, wie Nutzung später zugeführt werden kann.

## Grundsatz
- Vertrag (License Instance) bleibt immutable.
- Nutzung ist ein separater Input: Metrikwerte pro Zeitraum und Scope.

## Beispiel Input
- `scope_type`, `scope_id`
- `metric_type` (pageviews|seats|installs|print_run|...)
- `value`
- `period_start`, `period_end`
- `source` (manual_import|analytics|hr|...)
- `evidence` optional (z. B. Link auf Report)

## Verwendung
- Policy Engine vergleicht `value` gegen `metric_limits`.
