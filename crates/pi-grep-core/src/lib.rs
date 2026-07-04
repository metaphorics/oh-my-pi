//! Engine-neutral grep core.
//!
//! Hosts the three builder seams shared by the ripgrep-backed search builtins:
//! - [`matcher`] — a neutral [`MatcherSpec`] to a [`grep_regex::RegexMatcher`].
//! - [`searcher`] — a neutral [`SearcherSpec`] to a
//!   [`grep_searcher::Searcher`], including binary-detection policy.
//! - [`walk`] — a neutral [`WalkSpec`] to a [`GrepWalk`], the *only*
//!   file-enumeration path. [`GrepWalk`] wraps `pi_walker` and always wires the
//!   cancellation heartbeat by construction, so no consumer can enumerate files
//!   without observing the caller's cancel flag.
//!
//! The crate takes no dependency on `pi-uutils-ctx` or any shell-builtin
//! thread-local state. Cancellation is passed in as a plain `Fn() -> bool`; CLI
//! flag parsing, printers, exit codes, and I/O context stay in the consumer.

pub mod matcher;
pub mod searcher;
pub mod walk;

pub use matcher::{MatcherSpec, build_matcher};
pub use searcher::{BinaryMode, SearcherSpec, binary_detection, build_searcher};
pub use walk::{Flow, GrepWalk, TypeSpec, WalkSpec, build_types, build_walk};
