//! Spec-to-[`RegexMatcher`] construction.
//!
//! [`MatcherSpec`] captures the already-resolved matcher knobs (case, word /
//! whole-line anchoring, fixed-strings, multiline, line terminator) so the
//! consumer resolves CLI flags into a neutral struct and the core just applies
//! them. Seeded from `pi-uu-grep`'s `rg` builder.

use grep_regex::{RegexMatcher, RegexMatcherBuilder};

/// Resolved matcher configuration shared by every consumer.
///
/// All fields are final decisions: the consumer folds mutually-exclusive CLI
/// flags (e.g. `--ignore-case` vs `--case-sensitive`) down to booleans before
/// constructing this.
#[derive(Clone, Debug, Default)]
pub struct MatcherSpec {
	/// Case-insensitive matching.
	pub case_insensitive:     bool,
	/// Smart-case: case-insensitive only when the pattern is all lowercase.
	pub case_smart:           bool,
	/// Match only whole words.
	pub word:                 bool,
	/// Match only whole lines (anchor each pattern to line boundaries).
	pub whole_line:           bool,
	/// Treat patterns as literal strings rather than regexes.
	pub fixed_strings:        bool,
	/// Enable multi-line semantics in the regex engine.
	pub multi_line:           bool,
	/// Make `.` match line terminators (multiline dotall).
	pub dot_matches_new_line: bool,
	/// Line terminator byte, or `None` to leave the builder default in place.
	pub line_terminator:      Option<u8>,
}

/// Build a [`RegexMatcher`] over `patterns` from a resolved [`MatcherSpec`].
///
/// Patterns are OR-ed via `build_many`, matching ripgrep's `-e` repetition.
pub fn build_matcher(
	patterns: &[String],
	spec: &MatcherSpec,
) -> Result<RegexMatcher, grep_regex::Error> {
	let mut builder = RegexMatcherBuilder::new();
	builder
		.case_insensitive(spec.case_insensitive)
		.case_smart(spec.case_smart)
		.word(spec.word)
		.whole_line(spec.whole_line)
		.fixed_strings(spec.fixed_strings)
		.multi_line(spec.multi_line)
		.dot_matches_new_line(spec.dot_matches_new_line);
	if let Some(terminator) = spec.line_terminator {
		builder.line_terminator(Some(terminator));
	}
	builder.build_many(patterns)
}

#[cfg(test)]
mod tests {
	use grep_matcher::Matcher;

	use super::*;

	#[test]
	fn regex_metacharacters_apply_by_default() {
		let spec =
			MatcherSpec { multi_line: true, line_terminator: Some(b'\n'), ..MatcherSpec::default() };
		let matcher = build_matcher(&["fo+".to_string()], &spec).expect("valid regex");
		assert!(matcher.is_match(b"foooo").unwrap());
		assert!(!matcher.is_match(b"bar").unwrap());
	}

	#[test]
	fn fixed_strings_disable_regex() {
		let spec = MatcherSpec {
			fixed_strings: true,
			multi_line: true,
			line_terminator: Some(b'\n'),
			..MatcherSpec::default()
		};
		let matcher = build_matcher(&["a.c".to_string()], &spec).expect("literal");
		assert!(matcher.is_match(b"a.c").unwrap());
		assert!(!matcher.is_match(b"aXc").unwrap(), "-F must not treat . as a wildcard");
	}

	#[test]
	fn whole_line_anchors() {
		let spec = MatcherSpec {
			whole_line: true,
			multi_line: true,
			line_terminator: Some(b'\n'),
			..MatcherSpec::default()
		};
		let matcher = build_matcher(&["beta".to_string()], &spec).expect("valid");
		assert!(matcher.is_match(b"beta").unwrap());
		assert!(!matcher.is_match(b"gamma beta").unwrap(), "-x rejects partial lines");
	}
}
