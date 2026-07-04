---
title: "grep.rs port silently deleted upstream streaming orchestration; restore wholesale, re-apply only the delta"
date: 2026-07-05
category: docs/solutions/logic-errors/
module: crates/pi-natives
problem_type: logic_error
component: grep
symptoms:
  - "FilesWithMatches reports a file for `foo\\s+bar` against \"foo\\nbar\" while Content mode reports no match"
  - "max_count grep returns matches from later-path files while earlier-path files are skipped (non-deterministic first-N)"
  - "large-tree grep materializes every FileCandidate into a Vec before searching (memory and first-result latency proportional to total file count)"
  - "Searcher rebuilt per file in the parallel pass instead of once per worker"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components: [pi-grep-core, pi-uu-grep, pi-walker]
tags: [grep, streaming, line-terminator, max-count, path-order, port, upstream-reconcile]
---

# grep.rs port silently deleted upstream streaming orchestration; restore wholesale, re-apply only the delta

## Problem

While porting `crates/pi-natives/src/grep.rs` matcher/searcher construction to `pi-grep-core` (PR #4550), a "reconcile with upstream parallel walker" commit rewrote the orchestration instead of preserving it — collapsing upstream's three streaming code paths into a single collect-all-candidates pass and dropping the matcher's line-terminator ladder. All Rust gates stayed green; a second bot review round caught 4 distinct regressions (8 threads, 8/8 confirmed on adversarial verification).

## Symptoms

- `FilesWithMatches` and `Content` modes disagreed: `foo\s+bar` matched across `"foo\nbar"` in files mode only.
- `max_count` results lost deterministic path order (racy shared `state.emitted` budget let later-path files starve earlier-path ones; post-sort cannot recover a file that was never searched).
- Whole-tree candidate collection before any search (streaming lost in both the no-budget and large-budget cases).
- `Searcher` constructed per file instead of per worker in the parallel pass.

## What Didn't Work

- Trusting green gates as behavior-preservation evidence: `cargo check`/`nextest`/`clippy` all passed on the broken commit. The deleted behaviors (early walk termination, path-ordered first-N under load, per-worker reuse, line-oriented whole-file `is_match`) had no test coverage — the parity suite covered the *builders*, not the *orchestration*.
- Patch-per-symptom would have meant re-deriving four subtle interacting behaviors by hand inside an already-diverged file.

## Solution

Restore `upstream/main`'s grep.rs **wholesale**, then re-apply only the intended port delta (the two builder functions). Result: orchestration byte-identical to upstream; the diff vs upstream confined to `build_regex_matcher` / `build_searcher_for_params`.

The one non-mechanical piece — delegating the matcher build while preserving upstream's line-terminator ladder:

```rust
let build = |line_terminated: bool| {
    let spec = pi_grep_core::MatcherSpec {
        case_insensitive: ignore_case,
        multi_line: multiline,
        line_terminator: line_terminated.then_some(b'\n'),
        ..pi_grep_core::MatcherSpec::default()
    };
    pi_grep_core::build_matcher(std::slice::from_ref(&pattern), &spec)
};
if !multiline && let Ok(matcher) = build(true) {
    return Ok(matcher);
}
build(false)
```

Fixed in `8a9d7554c` (orchestration) and `496504847` (`rg:` prefix on the `collect_filtered_files` boundary in pi-uu-grep).

## Why This Works

The load-bearing invariants of grep.rs orchestration, none of which are visible from the builder API:

1. **Three-way streaming dispatch** in `run_streaming_grep`: no budget → `run_parallel_streaming_grep` (true streaming via `for_each_file_candidate_parallel`, no whole-tree Vec); small budget or single worker → `run_sequential_grep`; large budget + multi-worker → `run_windowed_streaming_grep`.
2. **Windowed max_count**: path-ordered `GREP_STREAM_WINDOW` (512-file) windows, each searched *fully* (`stop_after_matches=None` inside a window), budget checked only at window boundaries. This is what makes first-N deterministic in path order — any per-file budget check shared across parallel workers is racy by construction.
3. **Per-worker searcher** via `pi_walker::execute_candidates_init` (init closure runs once per worker), not `execute_candidates` with the builder inside the per-file callback.
4. **Line-terminator ladder**: `grep-regex` with `line_terminator(Some(b'\n'))` strips `\n` from `\s`/negated classes so the matcher cannot match across a line boundary — and the build *fails* for patterns that must match a literal `\n`, which is exactly why the try-`Some`-then-fall-back-to-`None` ladder exists. The whole-file `matcher.is_match(bytes)` fast paths (FilesWithMatches) depend on this to agree with the line-oriented Content searcher.

Wholesale restoration fixes 1–3 *by construction* (byte-identical to upstream) instead of by re-derivation; only invariant 4 needed genuine merge work.

## Prevention

- When a port/refactor of file X against a moving upstream goes wrong, prefer `git show upstream/main:X` as the base and re-apply the intended delta — the burden of proof flips to each re-applied hunk instead of each deleted line.
- Orchestration deltas in a "port the builders" commit are scope drift: a delegation commit should show a diff confined to construction functions. Review the diff-vs-upstream *shape*, not just the tests.
- The discriminating probe for line-terminator regressions: files-with-matches for `foo\s+bar` against a file containing `foo\nbar` (must NOT report the file). For path-order: `max_count` small enough to exclude the alphabetically-last file in a multi-file tree.
- `pi-grep-core` must stay engine-neutral: zero `pi-uutils-ctx` edges (`cargo tree -p pi-grep-core --edges normal | grep uutils-ctx` empty) and no `rg:` prefixes in core error strings — consumers prefix at their boundary.

## Related

- PR #4550 (can1357/oh-my-pi) — threads and fix discussion.
- `docs/natives-text-search-pipeline.md` — the pipeline overview (does not cover the streaming dispatch internals; this doc is the record of why they are load-bearing).
