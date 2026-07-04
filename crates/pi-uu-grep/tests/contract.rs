//! Grep engine contract/parity suite — `pi-uu-grep` side (Task 10).
//!
//! Drives the `grep` and `rg` shell builtins through their public
//! `run`/`run_rg` entry points over the shared [`pi_grep_testkit`] corpus, and
//! pins the observable behavior (stdout lines, counts, exit codes) that the
//! future `pi-grep-core` extraction (T11) and the `pi-natives` port (T12) must
//! preserve.
//!
//! Each case is annotated as either:
//! - `contract:` — behavior both relevant engines agree on, or
//! - `parity-gap:` — a discovered disagreement, pinned here for the engine this
//!   crate owns; the cross-engine target lives in [`parity_gaps`] as an
//!   `#[ignore]`d executable note. See `.outline/sdd/t10-report.md`.

use std::{
	collections::HashMap,
	ffi::OsString,
	io::{self, Cursor, Write},
	path::Path,
	sync::{Arc, atomic::AtomicBool},
};

use parking_lot::Mutex;
use pi_grep_testkit as fx;
use pi_uutils_ctx::{ScopeIo, scope};

#[derive(Clone, Copy)]
enum Builtin {
	Grep,
	Rg,
}

struct SharedBuf(Arc<Mutex<Vec<u8>>>);

impl Write for SharedBuf {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		self.0.lock().extend_from_slice(buf);
		Ok(buf.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

struct Output {
	code:   i32,
	stdout: Vec<u8>,
	stderr: String,
}

impl Output {
	fn text(&self) -> std::borrow::Cow<'_, str> {
		String::from_utf8_lossy(&self.stdout)
	}

	/// Newline-terminated stdout lines, terminators trimmed.
	fn lines(&self) -> Vec<String> {
		self.text().lines().map(str::to_string).collect()
	}

	fn line_count(&self) -> usize {
		self.text().lines().count()
	}

	fn has_line(&self, needle: &str) -> bool {
		self.text().lines().any(|line| line == needle)
	}
}

/// Run `builtin` with `args` over `stdin`, resolving relative paths against
/// `cwd`. `search_input` mirrors the shell flagging stdin as searchable.
fn run(builtin: Builtin, args: &[&str], stdin: &[u8], cwd: &Path, search_input: bool) -> Output {
	let out = Arc::new(Mutex::new(Vec::new()));
	let err = Arc::new(Mutex::new(Vec::new()));
	let io = ScopeIo {
		stdin:                 Box::new(Cursor::new(stdin.to_vec())),
		stdin_fd:              None,
		stdin_is_search_input: search_input,
		stdout:                Box::new(SharedBuf(Arc::clone(&out))),
		stderr:                Box::new(SharedBuf(Arc::clone(&err))),
		cwd:                   cwd.to_path_buf(),
		env:                   HashMap::new(),
		cancel:                Arc::new(AtomicBool::new(false)),
	};
	let name = match builtin {
		Builtin::Grep => "grep",
		Builtin::Rg => "rg",
	};
	let argv: Vec<OsString> = std::iter::once(name)
		.chain(args.iter().copied())
		.map(OsString::from)
		.collect();
	let code = scope(io, || match builtin {
		Builtin::Grep => pi_uu_grep::run(argv),
		Builtin::Rg => pi_uu_grep::run_rg(argv),
	});
	Output {
		code,
		stdout: out.lock().clone(),
		stderr: String::from_utf8_lossy(&err.lock()).into_owned(),
	}
}

/// Search `stdin` bytes with `builtin` and `args` (implicit stdin operand `-`).
fn on_stdin(builtin: Builtin, args: &[&str], stdin: &[u8]) -> Output {
	let cwd = std::env::temp_dir();
	let mut full: Vec<&str> = args.to_vec();
	full.push("-");
	run(builtin, &full, stdin, &cwd, true)
}

/// Search a single materialized file named `input.dat` with `builtin`/`args`.
fn on_file(builtin: Builtin, args: &[&str], contents: &[u8]) -> Output {
	let tree = fx::TempTree::new("uu-file");
	tree.write("input.dat", contents);
	let mut full: Vec<&str> = args.to_vec();
	full.push("input.dat");
	run(builtin, &full, b"", tree.path(), false)
}

/// Sorted relative paths reported by a recursive search (`path:line` → `path`).
fn matched_paths(out: &Output) -> Vec<String> {
	let mut paths: Vec<String> = out
		.lines()
		.iter()
		.filter_map(|line| line.split_once(':').map(|(path, _)| path.to_string()))
		.collect();
	paths.sort();
	paths.dedup();
	paths
}

// ===========================================================================
// Matcher semantics
// ===========================================================================
mod matcher {
	use super::{Builtin, fx, on_stdin};

	#[test]
	fn literal_and_regex_metacharacters() {
		// contract: a valid regex is applied as a regex — `fo+` matches repeats.
		let out = on_stdin(Builtin::Rg, &["fo+"], b"foooo\nbar\nfo\n");
		assert_eq!(out.code, 0);
		assert!(out.has_line("foooo") && out.has_line("fo"));
		assert!(!out.has_line("bar"));
	}

	#[test]
	fn fixed_strings_disable_regex() {
		// contract: -F matches metacharacters literally in both engines.
		for engine in [Builtin::Grep, Builtin::Rg] {
			let out = on_stdin(engine, &["-F", "a.c"], b"a.c\naXc\n");
			assert_eq!(out.code, 0);
			assert!(out.has_line("a.c"));
			assert!(!out.has_line("aXc"), "-F must not treat . as a wildcard");
		}
	}

	#[test]
	fn case_insensitive_unicode_folds() {
		// contract: -i folds Unicode case (é ↔ É), agreed by grep, rg, pi-natives.
		for engine in [Builtin::Grep, Builtin::Rg] {
			let out = on_stdin(engine, &["-i", "café"], fx::UNICODE.as_bytes());
			assert_eq!(out.code, 0);
			assert_eq!(out.lines(), ["café", "CAFÉ"], "{}", "engine differed");
		}
	}

	#[test]
	fn word_boundary() {
		// contract: -w matches whole words only, agreed by grep and rg.
		for engine in [Builtin::Grep, Builtin::Rg] {
			let plain = on_stdin(engine, &["foo"], fx::WORD.as_bytes());
			assert_eq!(plain.line_count(), 2, "without -w, substring in foobar matches");
			let worded = on_stdin(engine, &["-w", "foo"], fx::WORD.as_bytes());
			assert_eq!(worded.lines(), ["foo bar"], "with -w, only the whole word matches");
		}
	}

	#[test]
	fn invert_match() {
		// contract: -v selects non-matching lines, agreed by grep and rg.
		for engine in [Builtin::Grep, Builtin::Rg] {
			let out = on_stdin(engine, &["-v", "beta"], fx::BASIC.as_bytes());
			assert_eq!(out.lines(), ["alpha", "Beta", "delta"]);
		}
	}

	#[test]
	fn line_regexp_anchors_whole_line() {
		// contract: -x requires the pattern to span the entire line.
		for engine in [Builtin::Grep, Builtin::Rg] {
			let out = on_stdin(engine, &["-x", "beta"], b"beta\ngamma beta\n");
			assert_eq!(out.lines(), ["beta"], "-x must reject the partial line");
		}
	}

	#[test]
	fn unicode_property_class() {
		// contract: \p{Greek} matches the Greek line in grep, rg, pi-natives.
		for engine in [Builtin::Grep, Builtin::Rg] {
			let out = on_stdin(engine, &[r"\p{Greek}"], fx::UNICODE.as_bytes());
			assert_eq!(out.lines(), ["Ωmega"]);
		}
	}

	#[test]
	fn rg_multiline_matches_across_lines() {
		// contract (rg ↔ pi-natives): a \n-bearing pattern matches across lines
		// only under multiline mode; both lines of the match are printed.
		let out = on_stdin(Builtin::Rg, &["-U", "foo\nbar"], fx::MULTILINE.as_bytes());
		assert_eq!(out.code, 0);
		assert_eq!(out.lines(), ["foo", "bar"]);
	}

	#[test]
	fn rg_newline_pattern_without_multiline_is_rejected() {
		// parity-gap: a literal \n in the pattern without -U is a hard error in
		// rg (line terminator forbidden in regex), whereas grep and pi-natives
		// silently find no match. Cross-engine note in parity_gaps::*.
		let out = on_stdin(Builtin::Rg, &["foo\nbar"], fx::MULTILINE.as_bytes());
		assert_eq!(out.code, 2);
		assert!(out.stderr.contains("not allowed"), "stderr: {}", out.stderr);
	}

	#[test]
	fn grep_invalid_regex_falls_back_to_literal() {
		// parity-gap: grep matches an unparseable pattern literally (exit 0);
		// rg rejects it (exit 2). pi-natives also falls back. See parity_gaps.
		let out = on_stdin(Builtin::Grep, &["fail)"], b"a fail) b\nok\n");
		assert_eq!(out.code, 0, "stderr: {}", out.stderr);
		assert!(out.has_line("a fail) b"));
	}

	#[test]
	fn extended_regex_reports_parse_error() {
		// contract: -E opts grep into strict extended-regex syntax (no fallback).
		let out = on_stdin(Builtin::Grep, &["-E", "fail)"], b"fail)\n");
		assert_eq!(out.code, 2);
		assert!(out.stderr.contains("grep:"));
	}
}

// ===========================================================================
// Searcher semantics
// ===========================================================================
mod searcher {
	use super::{Builtin, fx, on_file, on_stdin, run};

	#[test]
	fn context_before_after_both() {
		// contract: -B/-A/-C select surrounding lines, agreed by grep and rg.
		for engine in [Builtin::Grep, Builtin::Rg] {
			let before = on_stdin(engine, &["-B1", fx::CONTEXT_PATTERN], fx::CONTEXT.as_bytes());
			assert_eq!(before.lines(), ["L2", "MATCH"]);
			let after = on_stdin(engine, &["-A1", fx::CONTEXT_PATTERN], fx::CONTEXT.as_bytes());
			assert_eq!(after.lines(), ["MATCH", "L4"]);
			let both = on_stdin(engine, &["-C1", fx::CONTEXT_PATTERN], fx::CONTEXT.as_bytes());
			assert_eq!(both.lines(), ["L2", "MATCH", "L4"]);
		}
	}

	#[test]
	fn utf16_bom_is_transcoded() {
		// contract: default BOM sniffing lets an ASCII pattern match UTF-16LE
		// content in grep, rg, and pi-natives.
		for engine in [Builtin::Grep, Builtin::Rg] {
			let out = on_file(engine, &["needle"], &fx::utf16le_bom("needle\n"));
			assert_eq!(out.code, 0);
			assert!(out.has_line("needle"));
		}
	}

	#[test]
	fn latin1_byte_does_not_block_ascii_match() {
		// contract: an invalid-UTF-8 (Latin-1) byte earlier on the line does not
		// prevent a contiguous ASCII match.
		for engine in [Builtin::Grep, Builtin::Rg] {
			let out = on_file(engine, &["needle"], &fx::latin1_line());
			assert_eq!(out.code, 0);
			assert_eq!(out.line_count(), 1);
		}
	}

	#[test]
	fn crlf_middle_line_matches() {
		// contract: a match on a CRLF-terminated middle line is found at that
		// line; the CR is part of the raw line bytes.
		let crlf = b"one\r\ntwo\r\nthree\r\n";
		for engine in [Builtin::Grep, Builtin::Rg] {
			let out = on_stdin(engine, &["-n", "two"], crlf);
			assert_eq!(out.code, 0);
			assert!(out.text().starts_with("2:two"), "got: {:?}", out.text());
		}
	}

	#[test]
	fn nul_single_file_is_searched_through() {
		// parity-gap: over a single file operand rg uses convert-binary detection
		// and grep uses none, so BOTH scan past the NUL and report two matches.
		// pi-natives uses quit and reports zero. Cross-engine note in parity_gaps.
		for engine in [Builtin::Grep, Builtin::Rg] {
			let out = on_file(engine, &["needle"], &fx::nul_binary());
			assert_eq!(out.lines(), ["needle one", "needle two"]);
		}
	}

	#[test]
	fn rg_max_filesize_excludes_large_files() {
		// contract: rg --max-filesize skips oversized files during a walk.
		let tree = fx::TempTree::new("maxsize");
		tree.mkdir(".git");
		tree.write("small.txt", b"needle\n");
		let mut big = b"needle ".to_vec();
		big.extend(std::iter::repeat_n(b'x', 4096));
		big.push(b'\n');
		tree.write("big.txt", &big);
		let limited =
			run(Builtin::Rg, &["--max-filesize", "64", "needle", "."], b"", tree.path(), false);
		assert_eq!(limited.lines(), ["small.txt:needle"], "big.txt exceeds the cap");
		let unlimited = run(Builtin::Rg, &["needle", "."], b"", tree.path(), false);
		assert_eq!(unlimited.line_count(), 2, "without the cap both files match");
	}

	#[test]
	fn rg_max_columns_omits_long_lines() {
		// parity-gap: rg replaces an over-long matching line with a placeholder,
		// whereas pi-natives truncates with an ellipsis. Pin rg's placeholder.
		let out = on_stdin(Builtin::Rg, &["-M", "10", "needle"], fx::long_line().as_bytes());
		assert_eq!(out.code, 0);
		assert!(out.text().contains("[Omitted long matching line]"), "got: {:?}", out.text());
	}
}

// ===========================================================================
// Result semantics
// ===========================================================================
mod result {
	use super::{Builtin, fx, on_stdin};

	#[test]
	fn line_numbers() {
		// contract: -n prefixes the 1-indexed line number.
		for engine in [Builtin::Grep, Builtin::Rg] {
			let out = on_stdin(engine, &["-n", "gamma"], fx::BASIC.as_bytes());
			assert_eq!(out.lines(), ["3:gamma beta"]);
		}
	}

	#[test]
	fn rg_column_is_first_match_byte_offset() {
		// contract: rg --column implies line numbers and appends the 1-based
		// byte column of the first match: `line:column:content`.
		let out = on_stdin(Builtin::Rg, &["--column", "beta"], fx::BASIC.as_bytes());
		// "gamma beta" is line 3; `beta` starts at byte 7 (1-based).
		assert_eq!(out.lines(), ["3:7:gamma beta"]);
	}

	#[test]
	fn count_of_matching_lines() {
		// contract: -c reports the count of matching lines (not total matches).
		for engine in [Builtin::Grep, Builtin::Rg] {
			let out = on_stdin(engine, &["-c", "beta"], b"beta beta\nno\nbeta\n");
			assert_eq!(out.lines(), ["2"], "two lines match, three occurrences");
		}
	}

	#[test]
	fn rg_count_matches_counts_occurrences() {
		// contract (rg): --count-matches counts every occurrence, not lines.
		let out = on_stdin(Builtin::Rg, &["--count-matches", "beta"], b"beta beta\nno\nbeta\n");
		assert_eq!(out.lines(), ["3"]);
	}

	#[test]
	fn only_matching_prints_spans() {
		// contract: -o emits each matched span on its own line.
		for engine in [Builtin::Grep, Builtin::Rg] {
			let out = on_stdin(engine, &["-o", "be.a"], b"gamma beta\nno\nbeta\n");
			assert_eq!(out.lines(), ["beta", "beta"]);
		}
	}

	#[test]
	fn quiet_sets_exit_code_without_output() {
		// contract: -q suppresses output; exit 0 on match, 1 on no match.
		for engine in [Builtin::Grep, Builtin::Rg] {
			let hit = on_stdin(engine, &["-q", "beta"], fx::BASIC.as_bytes());
			assert_eq!(hit.code, 0);
			assert!(hit.stdout.is_empty());
			let miss = on_stdin(engine, &["-q", "zzz"], fx::BASIC.as_bytes());
			assert_eq!(miss.code, 1);
			assert!(miss.stdout.is_empty());
		}
	}

	#[test]
	fn no_match_exit_code_is_one() {
		// contract: exit 1 when nothing matched, 0 when something did.
		for engine in [Builtin::Grep, Builtin::Rg] {
			assert_eq!(on_stdin(engine, &["zzz"], fx::BASIC.as_bytes()).code, 1);
			assert_eq!(on_stdin(engine, &["alpha"], fx::BASIC.as_bytes()).code, 0);
		}
	}

	#[test]
	fn rg_max_count_stops_after_n_matches() {
		// contract (rg ↔ pi-natives): -m N caps output at the first N matching
		// lines (early exit). pi-natives pins the same via SearchOptions
		// max_count in grep::tests::contract_max_count_caps_matches. parity-gap:
		// the grep builtin exposes no max-count flag at all — see parity_gaps.
		let out = on_stdin(Builtin::Rg, &["-m", "1", "beta"], b"beta one\nbeta two\nbeta three\n");
		assert_eq!(out.code, 0, "stderr: {}", out.stderr);
		assert_eq!(out.lines(), ["beta one"], "only the first match survives -m 1");
	}
}

// ===========================================================================
// Walk semantics (routed through pi_walker — never-bypass invariant)
// ===========================================================================
mod walk {
	use super::{Builtin, fx, matched_paths, run};

	#[test]
	fn rg_defaults_exclude_hidden_and_ignored() {
		// contract (rg ↔ pi-natives on gitignore): the .gitignore'd file is
		// skipped. parity-gap on hidden: rg also excludes .hidden.txt by
		// default, whereas pi-natives includes hidden files.
		let tree = fx::walk_corpus("rg-default");
		let out = run(Builtin::Rg, &["needle", "."], b"", tree.path(), false);
		assert_eq!(matched_paths(&out), fx::WALK_ALWAYS_VISIBLE);
	}

	#[test]
	fn rg_hidden_flag_includes_dotfiles_but_still_respects_ignore() {
		// contract: --hidden adds .hidden.txt; .gitignore is still honored.
		let tree = fx::walk_corpus("rg-hidden");
		let out = run(Builtin::Rg, &["--hidden", "needle", "."], b"", tree.path(), false);
		assert_eq!(matched_paths(&out), [".hidden.txt", "a.txt", "b.txt", "sub/c.txt"]);
	}

	#[test]
	fn rg_no_ignore_reaches_gitignored_file() {
		// contract: --no-ignore --hidden reaches every corpus file.
		let tree = fx::walk_corpus("rg-noignore");
		let out =
			run(Builtin::Rg, &["--no-ignore", "--hidden", "needle", "."], b"", tree.path(), false);
		assert_eq!(matched_paths(&out), [
			".hidden.txt",
			"a.txt",
			"b.txt",
			"ignored.txt",
			"sub/c.txt"
		]);
	}

	#[test]
	fn grep_recursive_ignores_gitignore_and_includes_hidden() {
		// parity-gap: the GNU-compatible grep builtin never consults .gitignore
		// and always includes hidden files, so it reaches every corpus file —
		// unlike rg and pi-natives, which respect .gitignore by default.
		let tree = fx::walk_corpus("grep-recursive");
		let out = run(Builtin::Grep, &["-r", "needle", "."], b"", tree.path(), false);
		assert_eq!(matched_paths(&out), [
			"./.hidden.txt",
			"./a.txt",
			"./b.txt",
			"./ignored.txt",
			"./sub/c.txt"
		]);
	}

	#[test]
	fn rg_sort_path_is_deterministic() {
		// contract: --sort path yields ascending path order (default is
		// explicitly unordered and must be treated as a set).
		let tree = fx::walk_corpus("rg-sort");
		let out = run(Builtin::Rg, &["--sort", "path", "needle", "."], b"", tree.path(), false);
		let paths: Vec<String> = out
			.lines()
			.iter()
			.filter_map(|l| l.split_once(':').map(|(p, _)| p.to_string()))
			.collect();
		assert_eq!(paths, ["a.txt", "b.txt", "sub/c.txt"], "sorted order must be stable");
	}

	#[test]
	fn rg_max_depth_limits_recursion() {
		// contract: --max-depth 1 excludes files nested below the root.
		let tree = fx::walk_corpus("rg-depth");
		let out = run(Builtin::Rg, &["--max-depth", "1", "needle", "."], b"", tree.path(), false);
		assert!(
			!matched_paths(&out).iter().any(|p| p.contains("sub/")),
			"nested file leaked past depth 1"
		);
		assert!(matched_paths(&out).contains(&"a.txt".to_string()));
	}

	/// Relative paths from a files-list mode (`-l`/`-L`), `./`-normalized and
	/// sorted. Unlike [`matched_paths`], these lines carry no `:line` suffix.
	fn listed_paths(out: &super::Output) -> Vec<String> {
		let mut names: Vec<String> = out
			.lines()
			.iter()
			.map(|l| l.trim_start_matches("./").to_string())
			.collect();
		names.sort();
		names
	}

	#[test]
	fn files_with_matches_lists_each_path_once() {
		// contract: files-with-matches mode names each file that contains a match
		// exactly once, with no line content. grep needs -r to recurse; rg
		// recurses by default.
		let tree = fx::TempTree::new("with-match");
		tree.mkdir(".git");
		tree.write("hit.txt", b"needle\nneedle again\n");
		tree.write("miss.txt", b"haystack\n");
		let grep = run(Builtin::Grep, &["-rl", "needle", "."], b"", tree.path(), false);
		let rg = run(Builtin::Rg, &["-l", "needle", "."], b"", tree.path(), false);
		for out in [&grep, &rg] {
			assert_eq!(out.code, 0, "stderr: {}", out.stderr);
			assert_eq!(listed_paths(out), ["hit.txt"], "only the matching file, listed once");
		}
	}

	#[test]
	fn rg_files_without_match_lists_non_matching_paths() {
		// contract (rg): --files-without-match names the files with no match at
		// all. parity-gap: the grep builtin does not implement GNU grep's -L and
		// rejects it at argument parsing (exit 2) — see parity_gaps.
		let tree = fx::TempTree::new("without-match");
		tree.mkdir(".git");
		tree.write("hit.txt", b"needle\n");
		tree.write("miss.txt", b"haystack\n");
		let rg = run(Builtin::Rg, &["--files-without-match", "needle", "."], b"", tree.path(), false);
		assert_eq!(rg.code, 0, "stderr: {}", rg.stderr);
		assert_eq!(listed_paths(&rg), ["miss.txt"], "only the non-matching file");
	}

	#[cfg(unix)]
	#[test]
	fn rg_does_not_follow_symlinks_by_default() {
		// contract: a symlink to a file is not traversed during a default walk,
		// so the target's content is searched once, not twice.
		let tree = fx::TempTree::new("rg-symlink");
		tree.mkdir(".git");
		tree.write("target.txt", b"needle here\n");
		std::os::unix::fs::symlink(tree.path().join("target.txt"), tree.path().join("link.txt"))
			.expect("create symlink");
		let out = run(Builtin::Rg, &["needle", "."], b"", tree.path(), false);
		assert_eq!(matched_paths(&out), ["target.txt"], "symlink must not be followed by default");
	}
}

// ===========================================================================
// Parity gaps — executable notes for T11/T12
//
// Each test encodes the *shared* behavior the two engines would exhibit if
// they routed through one `pi-grep-core`. They fail today because the engines
// diverge, so they are #[ignore]d with the divergence recorded. T11/T12 should
// un-ignore the ones the unified core is meant to satisfy.
// ===========================================================================
mod parity_gaps {
	use super::{Builtin, fx, on_file, on_stdin};

	#[test]
	#[ignore = "parity-gap: invalid regex — rg errors (exit 2); grep + pi-natives fall back to \
	            literal (exit 0)"]
	fn rg_invalid_regex_should_fall_back_to_literal() {
		// current: rg exits 2 on `fail)`. Target (grep/pi-natives): literal match.
		let out = on_stdin(Builtin::Rg, &["fail)"], b"a fail) b\n");
		assert_eq!(out.code, 0);
		assert!(out.has_line("a fail) b"));
	}

	#[test]
	#[ignore = "parity-gap: single-file NUL — rg/grep scan through (convert/none); pi-natives quits \
	            at NUL and reports 0"]
	fn single_file_nul_binary_policy_should_agree_with_pi_natives() {
		// current: rg reports two matches over a NUL-bearing file. pi-natives
		// (quit detection) reports zero. A unified core must pick one policy.
		let out = on_file(Builtin::Rg, &["needle"], &fx::nul_binary());
		assert_eq!(out.line_count(), 0, "target: quit-binary parity with pi-natives");
	}

	#[test]
	#[ignore = "parity-gap: files-without-match — rg supports --files-without-match; the grep \
	            builtin does not implement GNU grep's -L and rejects it with exit 2"]
	fn grep_should_support_files_without_match() {
		// current: grep exits 2 on -L (unknown flag). Target: -rL names every file
		// with no match, matching rg --files-without-match. The token is absent
		// from both files, so both must be listed.
		let tree = fx::TempTree::new("gap-nomatch");
		tree.mkdir(".git");
		tree.write("one.txt", b"alpha\n");
		tree.write("two.txt", b"beta\n");
		let out = super::run(Builtin::Grep, &["-rL", "absent-token", "."], b"", tree.path(), false);
		assert_eq!(out.code, 0, "stderr: {}", out.stderr);
		let mut names: Vec<String> = out
			.lines()
			.iter()
			.map(|l| l.trim_start_matches("./").to_string())
			.collect();
		names.sort();
		assert_eq!(names, ["one.txt", "two.txt"], "both files lack the token");
	}

	#[test]
	#[ignore = "parity-gap: max-count — rg + pi-natives support -m/--max-count first-match early \
	            exit; the grep builtin exposes no max-count flag and rejects -m with exit 2"]
	fn grep_should_support_max_count() {
		// current: grep exits 2 on -m (unknown flag). Target: -m 1 returns only
		// the first matching line, matching rg -m 1 and pi-natives max_count.
		let out = super::on_stdin(Builtin::Grep, &["-m", "1", "beta"], b"beta one\nbeta two\n");
		assert_eq!(out.code, 0, "stderr: {}", out.stderr);
		assert_eq!(out.lines(), ["beta one"]);
	}

	#[test]
	#[ignore = "parity-gap: hidden default — rg excludes dotfiles; pi-natives includes them"]
	fn hidden_files_default_should_agree_with_pi_natives() {
		// current: rg excludes .hidden.txt by default; pi-natives includes it.
		let tree = fx::walk_corpus("gap-hidden");
		let out = super::run(Builtin::Rg, &["needle", "."], b"", tree.path(), false);
		assert!(super::matched_paths(&out).contains(&".hidden.txt".to_string()));
	}
}
