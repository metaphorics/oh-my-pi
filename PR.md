# omp simplification campaign — maintainer walkthrough

Twelve open PRs against `can1357/oh-my-pi`, all from `metaphorics/oh-my-pi`, all
based on `003bb5548c` (17.2.8). Every unit is one atomic commit plus one
review-fix commit, independently reviewed before publication.

Read them in the tier order below. Tiers A–C and E are mutually independent —
merge in any order within a tier. **Tier D is a strict chain.**

## Tier A — config ratchets, zero runtime effect

Cheapest to review: no source behavior changes at all.

| PR | Title | Diff shape |
|---|---|---|
| [#7609](https://github.com/can1357/oh-my-pi/pull/7609) | `chore(ts): enforce switch non-fallthrough` | one line in `tsconfig.base.json` |
| [#7612](https://github.com/can1357/oh-my-pi/pull/7612) | `chore(ts): enforce noImplicitOverride` | flag + 99 `override` keywords across 38 files |

Both turn an already-true property of the codebase into a compiler check.
`tsgo` was confirmed to actually enforce each flag (a deliberate violation
reproduces `TS7029` / `TS4114`), so these are real guards rather than
false-safety no-ops.

Neither carries a CHANGELOG entry, and both reviews flagged that as a
maintainer's call. My reasoning for declining: a changelog documents observable
consumer impact, and a type-only flag with no runtime effect has none.
Say the word and I will add entries.

**#7612 CI note:** `Test TS workspace fast` fails on
`packages/ai/test/schema-wire.test.ts > arkToWireSchema — authored property
order`. That test also fails on pristine `003bb5548c` — pre-existing, not
introduced here. The commit touches no schema code.

## Tier B — duplicate collapse, independent

| PR | Title | What collapses |
|---|---|---|
| [#7581](https://github.com/can1357/oh-my-pi/pull/7581) | `refactor(collab-web): collapse duplicate shortenPath` | two `shortenPath` copies → the `lib/format` one |
| [#7585](https://github.com/can1357/oh-my-pi/pull/7585) | `refactor(utils): centralize tilde expansion` | four `expandTilde` copies → `pi-utils` |
| [#7586](https://github.com/can1357/oh-my-pi/pull/7586) | `refactor: centralize version comparison in pi-utils` | four version comparators → one |
| [#7589](https://github.com/can1357/oh-my-pi/pull/7589) | `refactor(ai): isolate SQLite credential store` | pure module move, byte-identical class body |

#7589 arrived with no findings; its review verified the relocation is
behavior-preserving line by line. The other three each took real fixes — see
"Review findings resolved" below.

## Tier C — standalone bug fix

| PR | Title |
|---|---|
| [#7620](https://github.com/can1357/oh-my-pi/pull/7620) | `fix(coding-agent): use ask tool for guided goal interview` |

One prompt line plus the two prose descriptions that documented the old flow.

## Tier D — stacked chain, merge in this exact order

Each branch contains its ancestors' commits, so a cherry-pick of a later unit
onto plain `main` will not apply. Merge top to bottom; identical changes resolve
cleanly.

| Order | PR | Title | Extracts |
|---|---|---|---|
| 1 | [#7594](https://github.com/can1357/oh-my-pi/pull/7594) | `refactor(coding-agent): centralize agent tool composition` | eight wrapper sites → one composition path |
| 2 | [#7599](https://github.com/can1357/oh-my-pi/pull/7599) | `refactor(coding-agent): extract session title generator` | `SessionTitleGenerator` |
| 3 | [#7603](https://github.com/can1357/oh-my-pi/pull/7603) | `refactor(coding-agent): extract session obfuscation` | `SessionObfuscation` |
| 4 | [#7608](https://github.com/can1357/oh-my-pi/pull/7608) | `refactor(coding-agent): extract session goal mode` | `SessionGoalMode` |

Units 2–4 pull three coherent concerns out of `agent-session.ts` using the same
host-thunk idiom, each preserving the public `AgentSession` surface.

**Most of the review traffic on 7599 / 7603 / 7608 was #7594's code**, seen
again through each stacked diff — the composition findings were fixed once on
#7594 and reach the rest by rebase. Only #7599 had a finding of its own (the
replan title path).

## Tier E — larger, independent

| PR | Title | Notes |
|---|---|---|
| [#7616](https://github.com/can1357/oh-my-pi/pull/7616) | `chore(ts): enforce noExplicitAny` | flag + ~150 `any` sites replaced across 85 files |
| [#7632](https://github.com/can1357/oh-my-pi/pull/7632) | `refactor(omptype): collapse dual validation engine into one walker` | `interp.ts` + `compile.ts` → `validate.ts` |

#7632 is the one worth real scrutiny. `omptype` ran two independent
implementations of the same validation semantics — a tree-walking interpreter
for a schema's first two calls and a `new Function` code generator from the
third on — with every rule written twice and lockstep enforced only by a
comment. It is now one module where each rule has a single statement both paths
consume. **It adds ~150 lines rather than removing them:** naming a shared rule
costs more than the duplicate literals it replaces. The purchase is that the
two paths can no longer drift, which is exactly the defect review found (below).

## Review findings resolved

Every finding was verified against the branch before being accepted or
declined. 47 inline threads plus 12 review bodies.

**#7581** — the canonical formatter splits on `/` and middle-elides, so
`https://example.com/a/b/c` rendered as `https:/…/b/c`. Fixed by keeping URLs
out of the path formatter; audited every `shortenPath` callsite in the package
and found two more URL-bearing paths (`inspect_image`, and `PathText`, which
`read` also feeds URLs through). The filesystem-path elision change is
intentional and now documented.

**#7585** — the shared helper had invented a `~foo` → `<home>/foo` branch. No
prior in-repo copy did that, and POSIX `~foo` names a *user*, so settings path
scopes silently changed meaning. Branch deleted; the re-export shim is gone and
all seven importers now take `pi-utils` directly.

**#7586** — three real defects. The shared comparator never throws, so dropping
the old parser let `999.bad` reach every manifest: explicit release versions are
now validated first. `ci-release-notes.ts` imported a workspace package in a CI
job that never runs `bun install`; it now imports the source by relative path.
And `compareSemverLikeVersions` still round-tripped huge numeric identifiers
through `Number` for cache pruning — deleted, routed through the comparator.

**#7594** — the blocking one, reproduced by review: a caller-created
`ToolDefinition` carries no private marker, so `isCustomTool` misclassified it
and execution received `(onUpdate, ctx, signal)` where `(signal, onUpdate, ctx)`
was expected. Rather than add a discriminator I removed the predicate and the
marker entirely and split composition into `composeCustomTool` and
`composeToolDefinition`, so the type system separates what structure cannot.
`CreateAgentSessionOptions.customTools` narrows to `CustomTool[]` with a new
`toolDefinitions` option — the union it used to accept was the latent bug.
Also restored load-mode normalization and `formatApprovalDetails` forwarding for
direct callers of the public converter, exported the API from the package root,
made runner-less misuse throw at composition time, kept the Cursor exec bridge
off the `artifact://` meta-notice it cannot resolve, and deleted a comment
claiming an ast-grep gate that does not exist.

**#7599** — the replan refresh called the generator's own `generateTitle`, so an
SDK integration overriding `AgentSession.generateTitle` governed the
first-message path but not the replan path. Routed through the host.

**#7616** — replaying a failed tool result dropped `errorMessage`, which the ACP
mapper reads as its fallback text source, leaving the client a failed call with
no explanation. Also replaced a banned `ReturnType<>` derivation with concrete
types and un-exported a constant that had no external consumer.

**#7632** — `objectExtraIndex` returned only the *first* matching index
signature, so the union fast path accepted values the JIT rejected: validation
depended on call count. It now applies the general index plus every matching
pattern index, matching the walker and the generator.

**#7620** — the instruction required a tool that `createTools()` omits when
`ask.enabled` is false, making `/guided-goal` unusable in a supported
configuration. It now uses the ask dialog when available and plain chat
otherwise. I deliberately did *not* auto-activate `ask`: the setting is a user
decision.

Declined, with reasoning stated on each thread: per-package CHANGELOG entries on
the type-only ratchets (#7612, #7609) and the no-op module move (#7589); a
compatibility alias for the removed `CustomToolAdapter` and the renamed
`compareVersions` (repo doctrine is break-and-document, and both are recorded
under `### Breaking Changes`).

## Verification

Per branch: `biome` clean, `tsgo --noEmit` clean, and the package suites for
every touched package.

`packages/coding-agent`'s suite carries ~91 pre-existing failures in this
environment, and they vary run to run — 5s timeouts under parallel load plus a
native-addon mismatch. Every apparent new failure on #7594 and #7616 was run in
isolation against pristine `003bb5548c`: all passed on both trees at a raised
timeout, so none is a regression. The same method cleared the one `musl-release`
failure and three `packages/utils` file-lock failures.

**Mutation coverage: 7 of 8 fixes** carry a test proven to fail when only its
fix is reverted. The exception is #7620 — its change is prompt prose, and a test
asserting prompt text would be a source-grep, which this repo bans. Its added
assertion guards the deliberate non-activation of `ask` instead.

CI on the fork sits at `SKIPPED` for several jobs and `action_required` is
common for fork PRs, so upstream runs are not a signal I can fully rely on;
the local package suites above are the evidence.


## Second review round

Pushing the fixes above triggered a re-review, which produced 25 threads —
11 distinct findings, each duplicated 2–4× across the stacked diffs. **Every one
was on code the first round wrote**, and every one was real:

- **#7594** — composition spread the definition to apply a load mode, which
  turned a class-instance `ToolDefinition` into a plain object and dropped its
  prototype `execute`. The resolved mode now travels beside the definition and
  the object passes through untouched. Also: `renderCall` was copied bare and
  lost its receiver (a `#private` read threw); plain-definition composition
  accepted a missing runner it could not build an `ExtensionContext` without, so
  the runner is now required; and SDK-supplied `toolDefinitions` ignored
  `defaultInactive`.
- **#7586** — the new guard accepted `17.2.8-rc.1`, and the publish step passes
  no `--tag`, so a prerelease would have become npm `latest` for every
  unqualified install and for `omp update`. Prereleases are rejected again.
  Separately `v17.2.8` passed the guard and reached `Cargo.toml` verbatim, which
  cargo rejects only after every manifest was already rewritten.
- **#7581** — glob summaries still elided every scope, so
  `src/**/*.ts; test/**/*.ts` rendered as `src/…/**/*.ts` and a `memory://` URI
  lost its scheme. The scheme guard is now one helper used at every callsite.
- **#7585** — `expandTilde` resolved `os.homedir()` before inspecting its input,
  so a pass-through path threw under an arbitrary-UID container with `HOME`
  unset, where `homedir()` raises `ENOENT`.
- **#7632** — the extras-reject classification recomputed the matching index
  validators, running a custom index-key refinement twice; a non-idempotent
  predicate could reject a property it had just validated.

All five are mutation-verified: each new test fails when only its own fix is
reverted, and I confirmed the exact failure mode in each case rather than taking
the worker's word for it. Wave-2 mutation coverage is 5 of 5.

The count halved (47 → 25 → pending) and each round's findings were new and
specific rather than restatements, so this read as a productive re-audit rather
than the non-convergent loop where each fix generates its own next wave. If a
third round returns findings that are again only about round-two code and the
count stops shrinking, that is the point to stop and hand you the disposition
instead of pushing another round.

### One decision still yours

`expandTilde` is no longer re-exported from
`@oh-my-pi/pi-coding-agent/tools/path-utils`. Two reviewers conflict here:
roboomp asked for the removal (clean cutover, single owner) and codex objects
that `./tools/*` is a public subpath mapping, so an external importer breaks.
No in-repo caller depends on it and external ones cannot be enumerated, which
leaves it boundary-class by my own rules.

Current state keeps it removed with a `### Breaking Changes` bullet. **I have not
treated that as settled** — restoring the re-export is a one-line commit if you
prefer the compatible route.
## Third round, then an independent grill

Wave three arrived on the second round's own fix code (9 findings) and was
fixed. Then all 13 branches were rebased onto current `upstream/main`
(`5af71dc9cf`) — which also retires the `schema-wire` failure noted above, since
upstream's `fc7cd30bd1` fixes exactly that ordering bug.

That rebase surfaced a trap worth recording: upstream inserted a `## [17.2.8]`
header at the same anchor as our `## [Unreleased]` entries, so seven branches
silently moved their bullets *inside a released section*. Released sections are
immutable, so every affected changelog was reconstructed from upstream's
canonical block with our entries merged back under `[Unreleased]`; the
`[17.2.8]` region is now byte-identical to upstream's on every branch.

A fourth review wave (20 threads, 11 distinct) then ran alongside an independent
adversarial grill: 12 code reviewers plus 3 security reviewers over each PR's own
diff. Ten diffs came back clean. The rest converged on real defects:

- **`approval` was frozen at composition** — flagged P1 by the bot and
  independently by the security reviewer. A class-based tool tightening
  `allow` → `prompt`/`deny` kept executing under the stale permissive value
  because the gate re-read nothing. Now a lazy bound getter.
- **Activation read shadowed inputs** — name collisions are last-wins, so a
  hidden definition could be re-activated by the visible entry it shadowed.
- **Composition erased caller generics**, losing schema-specific typings the
  removed adapter provided.
- **`release.ts` pulled native bindings through the pi-utils barrel**, so
  `scripts/release.test.ts` never executed on a clean checkout — proven by
  moving `packages/natives/native` aside: before, the file died on
  `Cannot find module '@oh-my-pi/pi-natives'`; after, its four assertions run.
  The CI wiring added a round earlier had been guarding nothing.
- **Four more renderers still corrupted scopes** (`grep` ×2, the `glob` badge,
  `ast-edit`), and `redactHome` could not redact a `file://` home path. Rather
  than patch a sixth site, the `shortenPath` re-export is retired: `compactPath`
  is identical for plain paths and non-destructive for scopes, so the safe
  formatter is now the only reachable one.
- **A guard that could not fail** — the assertion that `/guided-goal` does not
  auto-enable `ask` was tautological, because the test registry never contained
  `ask`. The harness now registers it while leaving it inactive, and the
  assertion was proven to fail when the command activates it.
- Plus a fluent return lost to `any` removal, a legacy numeric-enum surface
  narrowed, replayed string tool-result content dropped, and the ask dialog's
  chat redirect not honored.

### Final state

Unresolved review threads across all 13 PRs: **0**. Ten of the thirteen were
re-reviewed after their final push and produced no findings; #7589, #7612, and
#7609 have not been re-reviewed since their rebase, which carried no content
change beyond the new base.

Thread series across the campaign: 47 → 25 → 12 → 20 → 0.

Every branch: `biome` clean, `tsgo --noEmit` clean, package suites green against
the documented pre-existing baseline (one `musl-release` failure and, for the
composition PRs, four `bridge tool resolution` / `pi_edit`-Cursor failures, all
reproduced on pristine `main`).

---

# omp cleanup campaign — maintainer walkthrough

Four open PRs against `can1357/oh-my-pi`, all from `metaphorics/oh-my-pi`, all
based on `06477855d1` (17.2.9). Separate from the simplification campaign above
and sharing no branches with it.

Every unit is exactly one commit off `main`. Nothing is stacked, so all four
merge in any order. Read Tier A first; it is the cheapest and the only tier with
fully green CI.

## Tier A — Rust dependency removal, no source changes

| PR | Title | Diff |
|---|---|---|
| [#7682](https://github.com/can1357/oh-my-pi/pull/7682) | `chore(deps): remove unused dependencies from first-party crates` | 4 files, +3/-18 |
| [#7683](https://github.com/can1357/oh-my-pi/pull/7683) | `chore(vendor): remove unused dependencies from vendored crates` | 16 files, +0/-30 |

Manifest-only. No `.rs` file changes in either. Both are CI green on all 20
checks, and `bun run check:rs` is the real gate here since a wrongly removed
dependency simply fails to compile.

`#7682` removes 10 dependency lines from `pi-natives` and `pi-walker`. `#7683`
removes 9 entries across 8 vendored manifests, plus the six now-stale
`//crates/pi-uutils-ctx` edges in the hand-maintained `BUILD.bazel` files so the
Cargo and Bazel graphs stay in agreement.

Both prune `Cargo.lock`, in disjoint places. Whichever merges second may need
the lock regenerated with `bun run check:rs`; no manual edit.

### The part worth your attention: three cargo-machete false positives

`cargo machete` reported 26 unused dependencies. Only 19 were real. The other
seven are load-bearing **without a use-position**, which is precisely the class
static analysis cannot see. All three patterns are documented in the PR bodies:

- **Feature injection.** `audiopus_sys` in `pi-voice` exists only so the
  workspace-root `features = ["static"]` unifies into the `audiopus_sys` build
  that `opus` pulls in, forcing the vendored static libopus. Deleting it
  compiles fine and silently switches every cargo-path build to the host
  libopus. Kept, and `#7682` adds a comment at the root pin so the next sweep
  does not repeat it.
- **Macro expansion.** `clap` in the five `sha*sum` crates and `md5sum` is
  reached only through `uu_checksum_common::declare_standalone!`, which expands
  to `pub fn uu_app() -> ::clap::Command`. Kept; `uu-md5sum` therefore drops out
  of `#7683` entirely. `uu-find` does not invoke that macro, so its `clap`
  removal stands.
- **Renamed crate.** `uutils_term_grid` in `uu-ls` is imported as `term_grid`
  (`src/config.rs:18`, `src/display.rs:33`). `uu-ls` is untouched.

If you run `cargo machete` on the merged result, those three will still be
reported. That is expected, not a regression.

## Tier B — TypeScript duplicate and dead-surface removal

| PR | Title | Diff |
|---|---|---|
| [#7685](https://github.com/can1357/oh-my-pi/pull/7685) | `refactor(coding-agent): construct CustomToolAdapter directly` | 3 files, +5/-12 |
| [#7687](https://github.com/can1357/oh-my-pi/pull/7687) | `refactor(coding-agent): reuse pi-utils asRecord in web scrapers` | 2 files, +6/-6 |

**`#7685` is a breaking change** and carries an `## [Unreleased]` →
`### Breaking Changes` entry. `CustomToolAdapter.wrap` was a one-line static
factory whose own doc comment said to prefer the constructor, but it was
genuinely public: `custom-tools/index.ts` star-exports `wrapper.ts`, and
`package.json` exposes both `./extensibility/custom-tools` and
`./extensibility/custom-tools/*`. The single in-repo caller is migrated and a
repo-wide search for `CustomToolAdapter.wrap` returns nothing.

`#7687` deletes a local `asRecord` that was equivalent by construction to the
`@oh-my-pi/pi-utils` one, and re-exports the shared implementation rather than
dropping the symbol, so the name, signature, `null`-on-non-record contract, and
the `./utils` import path used by `w3c.ts` all survive. The `{}`-returning
`ai/dialect/coercion.ts` variant and the private search-provider copies are
deliberately untouched.

Both add a section under the same `## [Unreleased]` heading in
`packages/coding-agent/CHANGELOG.md`, so whichever merges second needs a trivial
changelog merge.

### CI is red on both, and it is not this work

Both fail `Test coding-agent native/unit (TS)` on
`test/tools/browser-attach.test.ts > pickElectronTarget > does not retry an
attached navigation failure as worker startup`. Evidence it is pre-existing:

- It fails at the base commit `06477855d1` run locally: 8 pass, 1 fail.
- Main's own CI run at that same commit ([run
  30984652742](https://github.com/can1357/oh-my-pi/actions/runs/30984652742)) is
  red.
- `#7687`'s failing job moved between runs (UI/TUI → native/unit) after only a
  changelog line was added, which is a flake signature.
- The test imports `tab-supervisor` and `puppeteer-core` and references none of
  the files either PR changes.

## Review state

Unresolved review threads across all four PRs: **0**. `#7682` came back
`P0 — lgtm` with no findings. The other three each had one `should-fix`, all
three verified against the branch before fixing, all three held, all three fixed
and answered:

| PR | Finding | Fix |
|---|---|---|
| #7683 | nested `brush-builtins/Cargo.lock` still listed the removed deps | `323be88` |
| #7685 | `CustomToolAdapter.wrap` is public API, needs a breaking-change entry | `e63ef0f` |
| #7687 | missing `## [Unreleased]` changelog entry | `5a115c7` |

One correction worth flagging on `#7683`: the review asked for the vendored
lockfile to be regenerated. Cargo cannot write it. `crates/vendor/brush-builtins`
is a root-workspace member with no `[workspace]` of its own, so every cargo
invocation there resolves through the root `Cargo.lock` (927 packages) and never
touches the nested one (283). `cargo update --workspace` run inside that
directory reports `Locking 0 packages` and leaves the file byte-identical. The
two entries were removed directly, which is safe because nothing consumes the
file. Only 2 of 49 vendored crates carry a nested lock, both inherited from the
brush upstream; `brush-core`'s is left alone since this campaign does not touch
its manifest.

Thread series across the campaign: 3 → 0.

Validation scope, stated honestly: Tier A is proven by `bun run check:rs`
(exit 0) plus CI green. Tier B is proven by `bun run check` (exit 0),
`bun run ci:test:smoke` (exit 0), and the covering test files (40/40 for
`#7685`); a contract probe for `#7687` confirms `asRecord` still returns an
object for a record and `null` for `null`, a number, and an array. Neither
Tier B PR is claimed green on the full `bun run test`: this checkout has a stale
prebuilt native addon (`diffLineRuns` undefined) that makes the same set of
hashline and Settings tests fail identically at the base commit.
