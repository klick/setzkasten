# Usage Interface (V1: Contract Only)

V1 does not measure usage automatically. It only defines how usage can be supplied later.

## Principle
- Contract (`License Instance`) remains immutable.
- Usage is a separate input: metric values per time period and scope.

## Example Input
- `scope_type`, `scope_id`
- `metric_type` (`pageviews` | `seats` | `installs` | `print_run` | ...)
- `value`
- `period_start`, `period_end`
- `source` (`manual_import` | `analytics` | `hr` | ...)
- optional `evidence` (for example a report link)

## Usage
- Policy engine compares `value` against `metric_limits`.
