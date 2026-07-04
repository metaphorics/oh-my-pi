//! Shared, byte-identical fixture corpus for the grep engine contract/parity
//! suite (Task 10).
//!
//! Both `pi-uu-grep`'s integration tests (which drive the `grep`/`rg` shell
//! builtins through their public `run`/`run_rg` entry points) and
//! `pi-natives`' in-crate `grep.rs` tests (which call the private
//! `search_sync`/`grep_sync` engine directly, because that crate is
//! `cdylib`-only and unreachable from an external test crate) depend on this
//! module so every engine observes the *same input bytes*. That is the whole
//! point: a parity suite is only meaningful if the two engines are fed
//! identical corpora.
//!
//! This crate carries no production code and is never published. It has zero
//! third-party dependencies so it stays cheap to compile into every test
//! binary that needs it.

use std::{
	fs,
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
	time::{SystemTime, UNIX_EPOCH},
};

// ---------------------------------------------------------------------------
// In-memory content fixtures
//
// These are fed to the engines as file contents / stdin. Line numbers in the
// doc comments are 1-indexed to match grep output.
// ---------------------------------------------------------------------------

/// Mixed-case lines for case-sensitivity and invert-match contracts.
///
/// 1:`alpha` 2:`Beta` 3:`gamma beta` 4:`delta`
///
/// - `beta` case-sensitive matches line 3 only.
/// - `beta` case-insensitive matches lines 2 and 3.
/// - inverting `beta` (case-sensitive) matches lines 1, 2, 4.
pub const BASIC: &str = "alpha\nBeta\ngamma beta\ndelta\n";

/// Word-boundary contrast for `-w`.
///
/// 1:`foobar baz` 2:`foo bar`
///
/// - `foo` without `-w` matches both lines (substring in `foobar`).
/// - `foo` with `-w` matches line 2 only (whole word).
pub const WORD: &str = "foobar baz\nfoo bar\n";

/// Cross-line block for multiline on/off behavior.
///
/// 1:`foo` 2:`bar` 3:`baz`
///
/// - pattern `foo\nbar` with multiline OFF matches nothing (line scanner never
///   sees the terminator).
/// - the same pattern with multiline ON matches at line 1.
pub const MULTILINE: &str = "foo\nbar\nbaz\n";

/// Unicode content for case folding and property classes.
///
/// 1:`café` 2:`CAFÉ` 3:`Ωmega` 4:`plain`
///
/// - `café` case-sensitive matches line 1; case-insensitive matches lines 1-2
///   (Unicode case folding of `é`/`É`).
/// - `\p{Greek}` matches line 3.
pub const UNICODE: &str = "café\nCAFÉ\nΩmega\nplain\n";

/// Five lines with a single interior match, for context windows.
///
/// 1:`L1` 2:`L2` 3:`MATCH` 4:`L4` 5:`L5`
///
/// - `-B1` adds line 2; `-A1` adds line 4; `-C1` adds both.
pub const CONTEXT: &str = "L1\nL2\nMATCH\nL4\nL5\n";

/// The literal pattern that matches [`CONTEXT`] exactly once, at line 3.
pub const CONTEXT_PATTERN: &str = "MATCH";

/// A file whose middle line carries an interior NUL byte.
///
/// 1:`needle one` 2:`plain\0text` 3:`needle two`
///
/// Engines using NUL binary detection (`quit`) stop at the binary line, so only
/// line 1 is reported. An engine without binary detection scans all three and
/// reports lines 1 and 3.
#[must_use]
pub fn nul_binary() -> Vec<u8> {
	let mut bytes = Vec::new();
	bytes.extend_from_slice(b"needle one\nplain");
	bytes.push(0);
	bytes.extend_from_slice(b"text\nneedle two\n");
	bytes
}

/// A line beginning with a Latin-1 byte (`0xE9`, `é`) that is invalid UTF-8,
/// followed by an ASCII match target.
///
/// 1:`caf\xe9 needle` 2:`plain`
///
/// `needle` is contiguous ASCII, so it matches at line 1 in every engine
/// regardless of the invalid byte earlier on the line.
#[must_use]
pub fn latin1_line() -> Vec<u8> {
	let mut bytes = Vec::new();
	bytes.extend_from_slice(b"caf");
	bytes.push(0xe9);
	bytes.extend_from_slice(b" needle\nplain\n");
	bytes
}

/// `text` encoded as UTF-16LE with a leading byte-order mark.
///
/// grep-searcher's default BOM sniffing transcodes this to UTF-8 before
/// matching, so an ASCII pattern finds the content.
#[must_use]
pub fn utf16le_bom(text: &str) -> Vec<u8> {
	let mut bytes = vec![0xff, 0xfe];
	for unit in text.encode_utf16() {
		bytes.extend_from_slice(&unit.to_le_bytes());
	}
	bytes
}

/// A single very long line (`needle` embedded between two 300-byte runs),
/// newline-terminated. Exercises long-line handling and column limits.
#[must_use]
pub fn long_line() -> String {
	format!("{}needle{}\n", "a".repeat(300), "b".repeat(300))
}

// ---------------------------------------------------------------------------
// On-disk corpus (walk semantics)
// ---------------------------------------------------------------------------

/// A self-cleaning unique temporary directory.
pub struct TempTree {
	path: PathBuf,
}

impl TempTree {
	/// Create a fresh, uniquely named temp directory under the system temp dir.
	///
	/// # Panics
	/// Panics if the directory cannot be created — a test cannot proceed
	/// without its fixtures.
	#[must_use]
	pub fn new(label: &str) -> Self {
		static COUNTER: AtomicU64 = AtomicU64::new(0);
		let nanos = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map_or(0, |d| d.as_nanos());
		let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
		let path = std::env::temp_dir()
			.join(format!("pi-grep-testkit-{label}-{}-{nanos}-{seq}", std::process::id()));
		fs::create_dir_all(&path).expect("create temp fixture tree");
		Self { path }
	}

	/// Root of the tree.
	#[must_use]
	pub fn path(&self) -> &Path {
		&self.path
	}

	/// Write a file at `relative` (creating parent directories) with `contents`.
	///
	/// # Panics
	/// Panics on any I/O error, since a missing fixture invalidates the test.
	pub fn write(&self, relative: &str, contents: &[u8]) {
		let target = self.path.join(relative);
		if let Some(parent) = target.parent() {
			fs::create_dir_all(parent).expect("create fixture parent dirs");
		}
		fs::write(&target, contents).expect("write fixture file");
	}

	/// Create an empty subdirectory at `relative`.
	///
	/// # Panics
	/// Panics on any I/O error.
	pub fn mkdir(&self, relative: &str) {
		fs::create_dir_all(self.path.join(relative)).expect("create fixture dir");
	}
}

impl Drop for TempTree {
	fn drop(&mut self) {
		let _ = fs::remove_dir_all(&self.path);
	}
}

/// One file in the standard walk corpus: (relative path, contents).
pub type CorpusFile = (&'static str, &'static str);

/// The standard walk corpus used by every walk-semantics contract case.
///
/// Every listed file contains the literal `needle` exactly once so a single
/// pattern exercises gitignore / hidden / recursion / ordering uniformly.
///
/// - `a.txt`, `b.txt`, `sub/c.txt` — always searched (visible, not ignored).
/// - `.hidden.txt` — searched only when hidden files are included.
/// - `ignored.txt` — matched by `.gitignore`; searched only when ignore rules
///   are disabled.
/// - `.gitignore` — itself hidden (leading dot) and lists `ignored.txt`.
///
/// A `.git` marker directory is created so gitignore processing activates.
pub const WALK_CORPUS: &[CorpusFile] = &[
	("a.txt", "needle a\n"),
	("b.txt", "needle b\n"),
	("sub/c.txt", "needle c\n"),
	(".hidden.txt", "needle hidden\n"),
	("ignored.txt", "needle ignored\n"),
	(".gitignore", "ignored.txt\n"),
];

/// Materialize [`WALK_CORPUS`] into a fresh [`TempTree`], including the `.git`
/// marker directory that activates gitignore handling.
#[must_use]
pub fn walk_corpus(label: &str) -> TempTree {
	let tree = TempTree::new(label);
	tree.mkdir(".git");
	for (relative, contents) in WALK_CORPUS {
		tree.write(relative, contents.as_bytes());
	}
	tree
}

/// The visible, non-ignored files in [`WALK_CORPUS`], as relative paths a
/// recursive search reaches under *every* engine's defaults intersection.
///
/// Excludes `.hidden.txt` (hidden), `.gitignore` (hidden), and `ignored.txt`
/// (gitignored) — the three whose inclusion is engine-dependent.
pub const WALK_ALWAYS_VISIBLE: &[&str] = &["a.txt", "b.txt", "sub/c.txt"];
