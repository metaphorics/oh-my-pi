# Task 38 report

## Implemented

- Restored keyed Kitty image ownership after budget demotion. Restoration keeps render-pass accounting, retransmission, release, and purge on one graphics ID; a concurrent key reacquisition is adopted without leaving an orphan mapping.
- Made top-level Nomnoml extraction list-aware with an indentation stack. Unordered, ordered, continuation-indented, and nested-list fences remain Markdown; a later top-level fence is still extracted.
- Made `setToolResultImages()` terminal after component disposal. Pending conversion continuations clear their in-flight key before dropping disposed results.
- Added direct component and real `EventController` late-result regressions.

## Verification

- `bun test packages/tui/test/image-budget.test.ts packages/tui/test/image-render.test.ts packages/coding-agent/src/modes/theme/mermaid-rendering.test.ts packages/coding-agent/test/modes/controllers/event-controller-read-grouping.test.ts packages/coding-agent/test/selector-settings-side-effects.test.ts packages/coding-agent/test/issue-3656-shake-during-stream.test.ts`: 96 passed, 0 failed.
- `bun run check:types` in `packages/tui`: passed.
- `bun run check:types` in `packages/coding-agent`: passed.
- Targeted Biome check/write over all five changed TypeScript files: passed.

## Mutation proofs

- Removing the restored-image ownership rebind made `restores keyed image ownership so release purges the retransmitted id exactly once` fail.
- Removing the list-nesting fence guard made the ordered-list two-space continuation regression fail.
- Removing the disposed entry guard made `ignores tool-result images delivered by an owner after disposal` fail.

Each mutation was restored before the final verification run.
