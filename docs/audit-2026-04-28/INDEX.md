# Audit 2026-04-28 — Index

This branch tracks a whole-repo audit of `metaphorics/oh-my-pi` (fork of `can1357/oh-my-pi`). Phase 1 dispatched 3 broad parallel investigators (Security, Correctness, Quality); Phase 2 reviewer dedup'd, source-verified, and ranked the findings.

**Status:** issues opened at upstream `can1357/oh-my-pi` (#855–#874). Phase 3b complete: 3 draft PRs for Batch 1 (P0+P1 fixes). #859 closed (false positive). #858 deferred (bun lacks `--provenance`).

## Summary

- 30 raw findings → 20 verified (after dedup, source verification, false-positive cuts)
- Severity: 1 P0, 13 P1, 6 P2
- Confidence: 11 High, 8 Med, 1 Low

## Ledger

(Severity × Confidence ordered. P0 first; ties broken by deliverable-shape concreteness.)

| # | Slug | Lens | Severity | Confidence | Shape | Issue | PR |
|---|------|------|----------|------------|-------|-------|-----|
| 1 | mcp-project-config-rce | Sec | P0 | High | full-fix-PR | [#855](https://github.com/can1357/oh-my-pi/issues/855) | [#877](https://github.com/can1357/oh-my-pi/pull/877) |
| 2 | ci-release-publish-orphans-swarm-extension | Qua | P1 | High | full-fix-PR | [#856](https://github.com/can1357/oh-my-pi/issues/856) | [#875](https://github.com/can1357/oh-my-pi/pull/875) |
| 3 | release-publish-loose-string-match | Qua | P1 | High | full-fix-PR | [#857](https://github.com/can1357/oh-my-pi/issues/857) | [#875](https://github.com/can1357/oh-my-pi/pull/875) |
| 4 | release-no-npm-provenance | Qua | P1 | High | deferred | [#858](https://github.com/can1357/oh-my-pi/issues/858) | — |
| 5 | release-script-regenerates-lockfiles-mid-release | Qua | P1 | High | false-positive | [#859](https://github.com/can1357/oh-my-pi/issues/859) | — |
| 6 | lsp-shutdown-signal-handler-orphans-children | Cor | P1 | High | full-fix-PR | [#860](https://github.com/can1357/oh-my-pi/issues/860) | [#876](https://github.com/can1357/oh-my-pi/pull/876) |
| 7 | oauth-token-url-from-config-exfil | Sec | P1 | Med | red-test-only | [#861](https://github.com/can1357/oh-my-pi/issues/861) |
| 8 | abort-skips-context-maintenance | Cor | P1 | High | red-test-only | [#862](https://github.com/can1357/oh-my-pi/issues/862) |
| 9 | shell-session-state-bleed | Sec | P1 | Med | red-test-only | [#863](https://github.com/can1357/oh-my-pi/issues/863) |
| 10 | symlink-toctou-write-and-plan-mode | Sec | P1 | Med | red-test-only | [#864](https://github.com/can1357/oh-my-pi/issues/864) |
| 11 | bash-controller-shared-singleton | Cor | P1 | High | red-test-only | [#865](https://github.com/can1357/oh-my-pi/issues/865) |
| 12 | compact-finalizer-clobbers-controller | Cor | P1 | High | red-test-only | [#866](https://github.com/can1357/oh-my-pi/issues/866) |
| 13 | retry-controller-overwrite-race | Cor | P1 | High | red-test-only | [#867](https://github.com/can1357/oh-my-pi/issues/867) |
| 14 | ci-nightly-rust-toolchain-pin | Qua | P1 | Med | issue-only | [#868](https://github.com/can1357/oh-my-pi/issues/868) |
| 15 | bash-cd-extraction-traversal-via-cwd | Sec | P2 | Med | red-test-only | [#869](https://github.com/can1357/oh-my-pi/issues/869) |
| 16 | debug-token-fingerprinting | Sec | P2 | Med | full-fix-PR | [#870](https://github.com/can1357/oh-my-pi/issues/870) |
| 17 | post-prompt-controller-replaced-without-drain | Cor | P2 | Med | red-test-only | [#871](https://github.com/can1357/oh-my-pi/issues/871) |
| 18 | ttsr-resume-promise-leak-on-abort | Cor | P2 | Low | red-test-only | [#872](https://github.com/can1357/oh-my-pi/issues/872) |
| 19 | package-exports-duplicate-hooks | Qua | P2 | High | full-fix-PR | [#873](https://github.com/can1357/oh-my-pi/issues/873) |
| 20 | sync-versions-stale-references | Qua | P2 | Med | full-fix-PR | [#874](https://github.com/can1357/oh-my-pi/issues/874) |

## Batch 1 (Phase 3b) — Draft PRs Opened

3 draft PRs covering 4 confirmed P0+P1 findings:

| PR | Findings | Description |
|----|----------|-------------|
| [#877](https://github.com/can1357/oh-my-pi/pull/877) | #855 (P0) | Capability-tagged config pipeline — project configs can't use `!`-prefix shell substitution |
| [#875](https://github.com/can1357/oh-my-pi/pull/875) | #856 + #857 (P1) | Workspace-derived package list + `--tolerate-republish` flag |
| [#876](https://github.com/can1357/oh-my-pi/pull/876) | #860 (P1) | Async `shutdownAll()` with `Promise.allSettled` completion gate |

- **#859** closed as false positive (all `bun install` uses `--frozen-lockfile`)
- **#858** deferred — `bun publish` lacks `--provenance`; bun's provenance support unclear

## Remaining Deferred

To convert any remaining finding to a PR:

1. `git fetch upstream main && git checkout -b audit/<slug> upstream/main`
2. Write the regression test (and the fix, if the row is `full-fix-PR` shaped)
3. Push to origin and open a draft PR with `Closes #<N>`

The 5 remaining `full-fix-PR` rows (#16, #19, #20 + batches 2-3) are ship-ready. The 10 `red-test-only` rows (#7–#13, #15, #17, #18) touch security or concurrency contracts where a characterization test demonstrating the bug is more useful than a unilateral fix. The single `issue-only` row (#14) needs maintainer context to pick a direction.

## Cuts (for record)

The Phase 2 reviewer cut these from the raw 30 findings:

- `sec-007-shell-prefix-no-validation` — false positive; `procmgr.ts:60-62` shows the shell prefix is sourced from env vars (`PI_SHELL_PREFIX`, `CLAUDE_CODE_SHELL_PREFIX`), not project-scope settings
- `agent-session-megaclass` — architectural opinion (7014 LOC, 13+ subsystems); not actionable as a single PR; appropriate as a separate `proposal`-labelled discussion if the maintainer wants the conversation
- `streaming-edit-cache-only-invalidates-on-edit-tool` — contract gap, not an observable bug (turn-start reset papers over the inconsistency)
- `native-preview-typescript-pinned-in-prod-check` — tooling-churn opinion without demonstrated exploit
- `verify-natives-allowlist-tightness` — speculative ("could permit false negatives") with no reproducer
- `stale-empty-files-and-todo-comments` — pure housekeeping; the actionable TODO-link concern is already covered by [#868](https://github.com/can1357/oh-my-pi/issues/868)

## Phase pipeline executed

| Phase | Outcome |
|-------|---------|
| 0 | Orient: repo structure mapped; `metaphorics/oh-my-pi` (fork) → `can1357/oh-my-pi` (upstream); branch clean |
| 1 | 3 broad parallel investigators (Sec / Cor / Qua) → 30 raw findings |
| 2 | Reviewer audit: dedup, source-verify, calibrate, rank → 20 verified |
| 2.5 | User approval gate: full-slate approved; PR shape adjusted to issues-first, PRs deferred |
| 3a | 20 issues filed at can1357/oh-my-pi#855..#874 |
| 3b | Batch 1 (4 findings): 3 draft PRs opened (#875, #876, #877); #859 closed (false positive); #858 deferred |
| 4 | This INDEX.md, updated with PR links |

## Notes

- Issues opened without labels because the audit author (`METAeuPHORIC`) lacks triage permission at upstream `can1357/oh-my-pi`. Each issue body documents severity, lens, and confidence inline so maintainer triage can apply labels from the body.
- The P0 (`mcp-project-config-rce`) was filed publicly per user choice; embargoed advisory was the alternative. The defanged exploit description in the issue body avoids one-click weaponization.
- This branch is **origin-only**; no upstream PR is opened for the index. Promote it to a PR or close it at will.
