//! Spec-to-[`GrepWalk`] construction and the sole file-enumeration API.
//!
//! [`WalkSpec`] captures the already-resolved traversal knobs (hidden/ignore
//! policy, symlink follow, path ordering, depth, size cap, glob overrides, and
//! type filters) plus the base directory used to anchor glob overrides. Seeded
//! from `pi-uu-grep`'s `rg` builder.
//!
//! [`GrepWalk`] is the *only* way this crate enumerates files. Both
//! [`GrepWalk::stream_files`] and [`GrepWalk::collect_files`] take a caller
//! cancellation predicate and wire it into `pi_walker`'s heartbeat themselves,
//! so a consumer can never accidentally pass a no-op heartbeat and let a walk
//! ignore the cancel flag (regression #3933). Error strings are engine-neutral:
//! they name the offending flag (`--glob`, `--type-add`, …) and the underlying
//! error, without any CLI prefix. A consumer prepends its own diagnostic prefix
//! (e.g. `rg:`) at the boundary where it surfaces the error.

use std::{
	io,
	path::{Path, PathBuf},
};

use ignore::{
	Match,
	overrides::{Override, OverrideBuilder},
	types::{Types, TypesBuilder},
};
use pi_walker::{FileType, WalkError, WalkStatus};

/// File-type selection state, mirroring ripgrep's `--type-*` flags.
#[derive(Clone, Debug, Default)]
pub struct TypeSpec {
	/// Type names to clear before applying selections (`--type-clear`).
	pub clears:  Vec<String>,
	/// Inline type definitions to add (`--type-add`).
	pub adds:    Vec<String>,
	/// Types to include (`--type`).
	pub selects: Vec<String>,
	/// Types to exclude (`--type-not`).
	pub negates: Vec<String>,
}

/// Resolved traversal configuration shared by every consumer.
#[derive(Clone, Debug)]
pub struct WalkSpec {
	/// Base directory used to anchor glob overrides (typically the shell cwd).
	pub cwd:            PathBuf,
	/// Include/exclude gitignore-style globs (`--glob`).
	pub globs:          Vec<String>,
	/// Case-insensitive include/exclude globs (`--iglob`).
	pub iglobs:         Vec<String>,
	/// File-type selection state.
	pub types:          TypeSpec,
	/// Raw `--max-filesize` argument, parsed lazily (`K`/`M`/`G` suffixes).
	pub max_filesize:   Option<String>,
	/// Descend into hidden files and directories.
	pub include_hidden: bool,
	/// Honor `.gitignore`/`.ignore` files and prune `.git`.
	pub respect_ignore: bool,
	/// Follow symbolic links.
	pub follow_links:   bool,
	/// Traverse in ascending path order (otherwise unordered).
	pub sort_path:      bool,
	/// Maximum traversal depth below the root (already unwrapped).
	pub max_depth:      usize,
}

/// Post-traversal path filters applied to each candidate entry.
struct PathFilters {
	overrides:    Option<Override>,
	types:        Option<Types>,
	max_filesize: Option<u64>,
}

impl PathFilters {
	/// Whether `path` (of kind `file_type`, with optional known `size`) survives
	/// the override/type/size filters. Directories are gated by overrides only.
	fn includes(&self, path: &Path, file_type: FileType, size: Option<f64>) -> bool {
		let is_dir = file_type == FileType::Dir;
		if self
			.overrides
			.as_ref()
			.is_some_and(|overrides| matches!(overrides.matched(path, is_dir), Match::Ignore(_)))
		{
			return false;
		}
		if file_type != FileType::File {
			return true;
		}
		if self
			.types
			.as_ref()
			.is_some_and(|types| matches!(types.matched(path, false), Match::Ignore(_)))
		{
			return false;
		}
		if let Some(limit) = self.max_filesize {
			let size = size.or_else(|| std::fs::metadata(path).ok().map(|meta| meta.len() as f64));
			if size.is_some_and(|size| size > limit as f64) {
				return false;
			}
		}
		true
	}
}

/// Traversal flow signalled by a [`GrepWalk::stream_files`] callback.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Flow {
	/// Keep walking.
	Continue,
	/// Stop the walk immediately.
	Stop,
}

/// A configured, filtered file walk over one root directory.
///
/// Build with [`build_walk`]; enumerate with [`GrepWalk::stream_files`] or
/// [`GrepWalk::collect_files`]. There is no other enumeration entry point, and
/// both methods wire the caller's cancel predicate into `pi_walker`'s
/// heartbeat.
pub struct GrepWalk {
	request: pi_walker::WalkRequest,
	filters: PathFilters,
	root:    PathBuf,
}

impl GrepWalk {
	/// Stream each *included regular file* to `visit_file`, wiring
	/// `is_cancelled` into the heartbeat so the walk always observes the cancel
	/// flag.
	///
	/// Filtered-out entries and non-files are handled internally and never reach
	/// `visit_file`; directory-open errors are delivered to `directory_error`.
	/// Both callbacks return a [`Flow`] to continue or stop the walk. The raw
	/// `pi_walker` result is returned so the consumer can distinguish
	/// completion, cancellation, and hard errors.
	pub fn stream_files<C, V, D>(
		&self,
		is_cancelled: C,
		mut visit_file: V,
		mut directory_error: D,
	) -> Result<WalkStatus, WalkError<io::Error>>
	where
		C: Fn() -> bool,
		V: FnMut(&Path) -> Flow,
		D: FnMut(&Path, &io::Error) -> Flow,
	{
		let filters = &self.filters;
		self.request.for_each_entry_with_heartbeat(
			|| {
				if is_cancelled() {
					Err(io::Error::from(io::ErrorKind::Interrupted))
				} else {
					Ok::<(), io::Error>(())
				}
			},
			|entry| {
				let path = entry.absolute_path.as_ref();
				if !filters.includes(path, entry.file_type, entry.size) {
					return Ok(if entry.file_type == FileType::Dir {
						pi_walker::WalkDecision::SkipDescend
					} else {
						pi_walker::WalkDecision::Skip
					});
				}
				if entry.file_type != FileType::File {
					return Ok(pi_walker::WalkDecision::Skip);
				}
				Ok(match visit_file(path) {
					Flow::Continue => pi_walker::WalkDecision::Include,
					Flow::Stop => pi_walker::WalkDecision::Stop,
				})
			},
			|error| {
				Ok(match directory_error(error.path, error.error) {
					Flow::Continue => pi_walker::WalkDecision::Include,
					Flow::Stop => pi_walker::WalkDecision::Stop,
				})
			},
		)
	}

	/// Collect every *included regular file* under the root, wiring
	/// `is_cancelled` into the heartbeat. Paths are returned unsorted (the
	/// caller applies any ordering it needs).
	pub fn collect_files<C>(&self, is_cancelled: C) -> Result<Vec<PathBuf>, WalkError<String>>
	where
		C: Fn() -> bool + Sync,
	{
		let outcome = self.request.collect_with_heartbeat(|| {
			if is_cancelled() {
				Err(io::Error::from(io::ErrorKind::Interrupted))
			} else {
				Ok::<(), io::Error>(())
			}
		})?;
		let mut files = Vec::new();
		for entry in outcome.entries {
			if entry.file_type != FileType::File {
				continue;
			}
			let path = entry.absolute_path(&self.root);
			if self.filters.includes(&path, entry.file_type, entry.size) {
				files.push(path);
			}
		}
		Ok(files)
	}
}

/// Parse a `--max-filesize` argument (`NUM`, or `NUM` with a `K`/`M`/`G`
/// suffix) into a byte count.
fn parse_size(input: &str) -> Result<u64, String> {
	let trimmed = input.trim();
	let Some(last) = trimmed.chars().last() else {
		return Err("empty size".to_string());
	};
	let (digits, multiplier) = match last {
		'K' | 'k' => (&trimmed[..trimmed.len() - 1], 1024),
		'M' | 'm' => (&trimmed[..trimmed.len() - 1], 1024 * 1024),
		'G' | 'g' => (&trimmed[..trimmed.len() - 1], 1024 * 1024 * 1024),
		_ => (trimmed, 1),
	};
	let value = digits
		.parse::<u64>()
		.map_err(|err| format!("invalid size {input:?}: {err}"))?;
	Ok(value.saturating_mul(multiplier))
}

/// Build a ripgrep [`TypesBuilder`] from a [`TypeSpec`].
///
/// Shared by [`build_walk`] (which calls `.build()` to obtain a [`Types`]
/// matcher) and by the consumer's `--type-list` output (which iterates the
/// definitions). Error strings are engine-neutral; the consumer prepends its
/// own CLI prefix (e.g. `rg:`) at the boundary.
pub fn build_types(spec: &TypeSpec) -> Result<TypesBuilder, String> {
	let mut builder = TypesBuilder::new();
	builder.add_defaults();
	for name in &spec.clears {
		builder.clear(name);
	}
	for def in &spec.adds {
		builder
			.add_def(def)
			.map_err(|err| format!("--type-add {def:?}: {err}"))?;
	}
	for name in &spec.selects {
		builder.select(name);
	}
	for name in &spec.negates {
		builder.negate(name);
	}
	Ok(builder)
}

fn build_path_filters(spec: &WalkSpec) -> Result<PathFilters, String> {
	let max_filesize = spec
		.max_filesize
		.as_ref()
		.map(|size| parse_size(size))
		.transpose()?;
	let overrides = if spec.globs.is_empty() && spec.iglobs.is_empty() {
		None
	} else {
		let mut overrides = OverrideBuilder::new(&spec.cwd);
		for glob in &spec.globs {
			overrides
				.add(glob)
				.map_err(|err| format!("--glob {glob:?}: {err}"))?;
		}
		if !spec.iglobs.is_empty() {
			overrides
				.case_insensitive(true)
				.map_err(|err| format!("--iglob: {err}"))?;
			for glob in &spec.iglobs {
				overrides
					.add(glob)
					.map_err(|err| format!("--iglob {glob:?}: {err}"))?;
			}
		}
		Some(overrides.build().map_err(|err| err.to_string())?)
	};
	let types = if spec.types.selects.is_empty() && spec.types.negates.is_empty() {
		None
	} else {
		Some(
			build_types(&spec.types)?
				.build()
				.map_err(|err| err.to_string())?,
		)
	};
	Ok(PathFilters { overrides, types, max_filesize })
}

/// Build a [`GrepWalk`] for `root` from a resolved [`WalkSpec`].
pub fn build_walk(spec: &WalkSpec, root: &Path) -> Result<GrepWalk, String> {
	let filters = build_path_filters(spec)?;
	let order = if spec.sort_path {
		pi_walker::WalkOrder::Path
	} else {
		pi_walker::WalkOrder::Unordered
	};
	let request = pi_walker::WalkRequest::new(root)
		.hidden(spec.include_hidden)
		.gitignore(spec.respect_ignore)
		.skip_git(spec.respect_ignore)
		.skip_node_modules(false)
		.follow_links(pi_walker::FollowLinks::from(spec.follow_links))
		.detail(if filters.max_filesize.is_some() {
			pi_walker::WalkDetail::Full
		} else {
			pi_walker::WalkDetail::Minimal
		})
		.order(order)
		.emit_root(false)
		.depth(1, spec.max_depth)
		.visit_order(pi_walker::VisitOrder::PreOrder)
		.directory_errors(pi_walker::DirectoryErrorMode::Visit)
		.same_file_system(false)
		.cache(false);
	Ok(GrepWalk { request, filters, root: root.to_path_buf() })
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

	use super::*;

	fn unique_tree(label: &str) -> PathBuf {
		let root = std::env::temp_dir().join(format!(
			"pi-grep-core-{label}-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.map(|d| d.as_nanos())
				.unwrap_or(0)
		));
		std::fs::create_dir_all(&root).expect("temp tree");
		root
	}

	fn spec_for(cwd: &Path) -> WalkSpec {
		WalkSpec {
			cwd:            cwd.to_path_buf(),
			globs:          Vec::new(),
			iglobs:         Vec::new(),
			types:          TypeSpec::default(),
			max_filesize:   None,
			include_hidden: true,
			respect_ignore: false,
			follow_links:   false,
			sort_path:      true,
			max_depth:      usize::MAX,
		}
	}

	#[test]
	fn parse_size_handles_suffixes() {
		assert_eq!(parse_size("64").unwrap(), 64);
		assert_eq!(parse_size("2K").unwrap(), 2048);
		assert_eq!(parse_size("1m").unwrap(), 1024 * 1024);
		assert_eq!(parse_size("1G").unwrap(), 1024 * 1024 * 1024);
		assert!(parse_size("").is_err());
		assert!(parse_size("xK").is_err());
	}

	#[test]
	fn stream_files_visits_regular_files() {
		let tree = unique_tree("stream");
		std::fs::write(tree.join("a.txt"), b"x\n").expect("write a");
		std::fs::write(tree.join("b.txt"), b"x\n").expect("write b");
		let walk = build_walk(&spec_for(&tree), &tree).expect("walk");
		let mut visited = Vec::new();
		let status = walk
			.stream_files(
				|| false,
				|path| {
					visited.push(path.file_name().unwrap().to_string_lossy().into_owned());
					Flow::Continue
				},
				|_, _| Flow::Continue,
			)
			.expect("walk ok");
		assert_eq!(status, WalkStatus::Complete);
		visited.sort();
		assert_eq!(visited, ["a.txt", "b.txt"]);
		let _ = std::fs::remove_dir_all(&tree);
	}

	#[test]
	fn stream_files_observes_cancellation_before_visiting() {
		// Direct core-level analogue of the builtins' cancellation regression
		// (#3933): a pre-set cancel flag must interrupt the walk via the wired
		// heartbeat before any file is visited.
		let tree = unique_tree("stream-cancel");
		std::fs::write(tree.join("a.txt"), b"x\n").expect("write");
		let walk = build_walk(&spec_for(&tree), &tree).expect("walk");
		let visits = AtomicUsize::new(0);
		let cancelled = AtomicBool::new(true);
		let result = walk.stream_files(
			|| cancelled.load(Ordering::Relaxed),
			|_| {
				visits.fetch_add(1, Ordering::Relaxed);
				Flow::Continue
			},
			|_, _| Flow::Continue,
		);
		assert!(matches!(result, Err(WalkError::Interrupted(_))), "cancel flag must interrupt");
		assert_eq!(visits.load(Ordering::Relaxed), 0, "no file visited after cancellation");
		let _ = std::fs::remove_dir_all(&tree);
	}

	#[test]
	fn collect_files_observes_cancellation() {
		let tree = unique_tree("collect-cancel");
		std::fs::write(tree.join("a.txt"), b"x\n").expect("write");
		let walk = build_walk(&spec_for(&tree), &tree).expect("walk");
		let result = walk.collect_files(|| true);
		assert!(matches!(result, Err(WalkError::Interrupted(_))), "cancel flag must interrupt");
		let _ = std::fs::remove_dir_all(&tree);
	}
}
