//! Spec-to-[`Searcher`] construction, including binary-detection policy.
//!
//! [`SearcherSpec`] captures the already-resolved searcher knobs (context
//! lines, inversion, multiline, max-count, NUL line terminator) plus the inputs
//! that decide binary handling. The [`BinaryMode`] distinguishes the two
//! searchers a caller builds: an *automatic* one for directory walks (quit at
//! NUL) and an *explicit* one for named file/stdin operands (convert NUL).
//! Seeded from `pi-uu-grep`'s `rg` builder.

use grep_matcher::LineTerminator;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder};

/// Which binary-detection policy a searcher should adopt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BinaryMode {
	/// Directory-walk searcher: quit at the first NUL unless overridden.
	Automatic,
	/// Explicit operand (named file or stdin): scan through, converting NUL.
	Explicit,
}

/// Resolved searcher configuration shared by every consumer.
#[derive(Clone, Debug, Default)]
pub struct SearcherSpec {
	/// Track line numbers during the scan.
	pub line_number:          bool,
	/// Context lines emitted before each match.
	pub before_context:       usize,
	/// Context lines emitted after each match.
	pub after_context:        usize,
	/// Emit every line (matching and non-matching).
	pub passthru:             bool,
	/// Invert matching (select non-matching lines).
	pub invert_match:         bool,
	/// Enable multi-line scanning.
	pub multi_line:           bool,
	/// Stop after this many matching lines per source.
	pub max_count:            Option<u64>,
	/// Treat NUL as the line terminator and disable binary detection.
	pub null_data:            bool,
	/// Search binary files as text (disable binary detection entirely).
	pub text:                 bool,
	/// Force convert-binary detection even in [`BinaryMode::Automatic`]
	/// (e.g. `--binary` or `-uuu`).
	pub force_convert_binary: bool,
}

/// Resolve the binary-detection policy for `spec` under `mode`.
pub fn binary_detection(spec: &SearcherSpec, mode: BinaryMode) -> BinaryDetection {
	if spec.text || spec.null_data {
		return BinaryDetection::none();
	}
	if spec.force_convert_binary || matches!(mode, BinaryMode::Explicit) {
		BinaryDetection::convert(b'\0')
	} else {
		BinaryDetection::quit(b'\0')
	}
}

/// Build a [`Searcher`] from a resolved [`SearcherSpec`] under `mode`.
pub fn build_searcher(spec: &SearcherSpec, mode: BinaryMode) -> Searcher {
	let binary_detection = binary_detection(spec, mode);
	let mut builder = SearcherBuilder::new();
	builder
		.line_number(spec.line_number)
		.before_context(spec.before_context)
		.after_context(spec.after_context)
		.passthru(spec.passthru)
		.invert_match(spec.invert_match)
		.multi_line(spec.multi_line)
		.binary_detection(binary_detection)
		.max_matches(spec.max_count);
	if spec.null_data {
		builder.line_terminator(LineTerminator::byte(b'\0'));
	}
	builder.build()
}
