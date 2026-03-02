# F8 Plan: Policy Presets

## Objective
Provide opinionated policy modes for different team maturity levels.

## Dependency Graph
```mermaid
graph TD
  T1[T1 Define preset semantics]
  T2[T2 Implement preset transformer]
  T3[T3 Wire CLI flags and listing]
  T4[T4 Add tests/docs]

  T1 --> T2
  T2 --> T3
  T3 --> T4
```

## Tasks
- `T1` Define behavior for `strict`, `startup`, `enterprise` (`depends_on: []`)
- `T2` Implement reason severity/decision transformation by preset (`depends_on: [T1]`)
- `T3` Add `policy --preset <name>` and `policy presets` command support (`depends_on: [T2]`)
- `T4` Add policy tests for each preset and update docs (`depends_on: [T3]`)

## Acceptance Criteria
- Preset usage is explicit and reflected in output metadata.
- Default policy behavior remains unchanged.
- Preset list is machine-readable for automation.
