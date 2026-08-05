/**
 * Shell-completion generation (bash, zsh, fish, PowerShell).
 *
 * Single source of truth: the declarative `flags`/`args` descriptors carried by
 * each `Command` subclass plus the registered subcommand table. {@link buildSpec}
 * walks that metadata — the same data `renderCommandBody` renders for `--help` —
 * and {@link generateCompletion} emits a self-contained completion script. Adding
 * a flag to a command's static `flags` therefore propagates into completions with
 * no edits here.
 *
 * Static candidates (enum `options`, the builtin tool list) are baked into the
 * script. A small set of flags resolve dynamic candidates (the live model
 * catalog and on-disk sessions) by calling back into `<bin> __complete <kind>`
 * — see `commands/complete.ts`. The flag→source mapping below is the only manual
 * knob and is keyed by flag name so it stays stable as flags are added.
 */
import type { ArgDescriptor, CliConfig, CommandMetadata, FlagDescriptor } from "@oh-my-pi/pi-utils/cli";
import { BUILTIN_TOOL_NAMES } from "../tools/builtin-names";

export type Shell = "bash" | "zsh" | "fish" | "powershell";

/** How a flag/positional value should be completed. */
export type ValueSource =
	| { kind: "flag" } // boolean — takes no value
	| { kind: "value" } // takes a value with no completable candidates (e.g. integer, free text)
	| { kind: "enum"; values: readonly string[] } // static single value
	| { kind: "list"; values: readonly string[] } // static comma-separated list
	| { kind: "models"; multiple: boolean } // dynamic: live model catalog
	| { kind: "sessions" } // dynamic: on-disk sessions
	| { kind: "file" }
	| { kind: "dir" };

export interface CompletionFlag {
	/** Long name without the leading `--`. */
	name: string;
	/** Short character without the leading `-`. */
	char?: string;
	description: string;
	value: ValueSource;
	/** Flag may appear multiple times (oclif `multiple`). */
	repeatable: boolean;
}

export interface CompletionArg {
	name: string;
	description: string;
	value: ValueSource;
}

export interface CompletionCommand {
	name: string;
	aliases: readonly string[];
	description: string;
	flags: CompletionFlag[];
	args: CompletionArg[];
}

export interface CompletionSpec {
	bin: string;
	/** Flags/args of the default (no-subcommand) command. */
	root: { flags: CompletionFlag[]; args: CompletionArg[] };
	commands: CompletionCommand[];
}

// --- Flag/arg value classification (the single manual mapping) ----------------

/** Single-value flags resolved against the live model catalog. */
const MODEL_FLAGS: Record<string, true> = { model: true, smol: true, slow: true, plan: true };
/** Single-value flags resolved against on-disk sessions. */
const SESSION_FLAGS: Record<string, true> = { resume: true, fork: true, session: true };
/** Flags whose value is a directory path. */
const DIR_FLAGS: Record<string, true> = { "session-dir": true, "plugin-dir": true };

function flagValue(name: string, desc: FlagDescriptor): ValueSource {
	if (desc.kind === "boolean") return { kind: "flag" };
	if (desc.options && desc.options.length > 0) return { kind: "enum", values: desc.options };
	if (MODEL_FLAGS[name]) return { kind: "models", multiple: false };
	if (name === "models") return { kind: "models", multiple: true };
	if (SESSION_FLAGS[name]) return { kind: "sessions" };
	if (name === "tools") return { kind: "list", values: BUILTIN_TOOL_NAMES };
	if (DIR_FLAGS[name]) return { kind: "dir" };
	if (desc.kind === "integer") return { kind: "value" };
	return { kind: "file" };
}

function argValue(desc: ArgDescriptor): ValueSource {
	if (desc.options && desc.options.length > 0) return { kind: "enum", values: desc.options };
	return { kind: "file" };
}

function buildFlags(command: CommandMetadata): CompletionFlag[] {
	const out: CompletionFlag[] = [];
	const flags = command.flags ?? {};
	for (const name in flags) {
		const desc = flags[name];
		out.push({
			name,
			char: desc.char,
			description: desc.description ?? "",
			value: flagValue(name, desc),
			repeatable: Boolean(desc.multiple),
		});
	}
	return out;
}

function buildArgs(command: CommandMetadata): CompletionArg[] {
	const out: CompletionArg[] = [];
	const args = command.args ?? {};
	for (const name in args) {
		const desc = args[name];
		out.push({ name, description: desc.description ?? "", value: argValue(desc) });
	}
	return out;
}

/**
 * Build a {@link CompletionSpec} from loaded command classes.
 *
 * @param rootName  Entry name of the default command (its flags become top-level
 *                  flags; it is excluded from the subcommand list).
 * @param aliasMap  Canonical-name → aliases (merged from the registration table
 *                  and the command class's static `aliases`).
 */
export function buildSpec(
	config: CliConfig,
	rootName: string,
	aliasMap: Map<string, readonly string[]>,
): CompletionSpec {
	const commands: CompletionCommand[] = [];
	let root: CompletionSpec["root"] = { flags: [], args: [] };
	for (const [name, Cmd] of config.commands) {
		const flags = buildFlags(Cmd);
		const args = buildArgs(Cmd);
		if (name === rootName) {
			root = { flags, args };
			continue;
		}
		if (Cmd.hidden) continue;
		commands.push({
			name,
			aliases: aliasMap.get(name) ?? [],
			description: Cmd.description ?? "",
			flags,
			args,
		});
	}
	commands.sort((a, b) => a.name.localeCompare(b.name));
	return { bin: config.bin, root, commands };
}

// --- Shared helpers -----------------------------------------------------------

/** Every value source except a bare boolean flag consumes the following token. */
function takesValue(v: ValueSource): boolean {
	return v.kind !== "flag";
}

/** All token forms (`name` + aliases) under which a subcommand can be invoked. */
function commandTokens(c: CompletionCommand): string[] {
	return [c.name, ...c.aliases];
}

export function generateCompletion(shell: Shell, spec: CompletionSpec): string {
	switch (shell) {
		case "bash":
			return generateBash(spec);
		case "zsh":
			return generateZsh(spec);
		case "fish":
			return generateFish(spec);
		case "powershell":
			return generatePowerShell(spec);
	}
}

// --- bash ---------------------------------------------------------------------

/** Escape for use inside a bash double-quoted `compgen -W "…"` word list. */
function bashWords(values: readonly string[]): string {
	return values.join(" ").replace(/"/g, '\\"');
}

/** bash snippet that fills COMPREPLY for a flag value, then `return 0`. */
function bashValueBranch(bin: string, v: ValueSource): string {
	switch (v.kind) {
		case "flag":
		case "value":
			return "return 0";
		case "enum":
			return `COMPREPLY=( $(compgen -W "${bashWords(v.values)}" -- "$cur") ); return 0`;
		case "list":
			return `_omp_comma "${bashWords(v.values)}"; return 0`;
		case "models":
			return v.multiple
				? `_omp_comma "$(command ${bin} __complete models 2>/dev/null | cut -f1)"; return 0`
				: `COMPREPLY=( $(compgen -W "$(command ${bin} __complete models -- "$cur" 2>/dev/null | cut -f1)" -- "$cur") ); return 0`;
		case "sessions":
			return `COMPREPLY=( $(compgen -W "$(command ${bin} __complete sessions -- "$cur" 2>/dev/null | cut -f1)" -- "$cur") ); return 0`;
		case "file":
			return `COMPREPLY=( $(compgen -f -- "$cur") ); compopt -o filenames; return 0`;
		case "dir":
			return `COMPREPLY=( $(compgen -d -- "$cur") ); compopt -o filenames; return 0`;
	}
}

/** Build the `case "$prev" in …` arms for every value-taking flag in scope. */
function bashFlagCase(bin: string, flags: CompletionFlag[]): string {
	const lines: string[] = [];
	for (const f of flags) {
		if (!takesValue(f.value)) continue;
		const labels = [`--${f.name}`, ...(f.char ? [`-${f.char}`] : [])];
		lines.push(`\t\t${labels.join("|")})\n\t\t\t${bashValueBranch(bin, f.value)}\n\t\t\t;;`);
	}
	return lines.join("\n");
}

function bashFlagWords(flags: CompletionFlag[]): string {
	const words: string[] = [];
	for (const f of flags) {
		words.push(`--${f.name}`);
		if (f.char) words.push(`-${f.char}`);
	}
	return words.join(" ");
}

function generateBash(spec: CompletionSpec): string {
	const { bin } = spec;
	const parts: string[] = [];
	parts.push(`# bash completion for ${bin} — generated by \`${bin} completions bash\``);
	parts.push("");

	// Comma-aware static/dynamic list completion helper.
	parts.push(`_omp_comma() {
	local words="$1" realcur prefix
	realcur="\${cur##*,}"
	prefix="\${cur%"$realcur"}"
	local -a matches
	matches=( $(compgen -W "$words" -- "$realcur") )
	local i
	for (( i=0; i < \${#matches[@]}; i++ )); do matches[i]="$prefix\${matches[i]}"; done
	COMPREPLY=( "\${matches[@]}" )
	compopt -o nospace 2>/dev/null
}`);
	parts.push("");

	// Root handler: top-level flags + subcommand names.
	const subTokens = spec.commands.flatMap(commandTokens).sort();
	parts.push(`_omp_root() {
	case "$prev" in
${bashFlagCase(bin, spec.root.flags)}
	esac
	if [[ "$cur" == -* ]]; then
		COMPREPLY=( $(compgen -W "${bashFlagWords(spec.root.flags)}" -- "$cur") )
	else
		COMPREPLY=( $(compgen -W "${bashWords(subTokens)} ${bashFlagWords(spec.root.flags)}" -- "$cur") )
	fi
}`);
	parts.push("");

	// Per-subcommand handlers.
	for (const c of spec.commands) {
		const argEnum = c.args.find(a => a.value.kind === "enum");
		const argWords = argEnum && argEnum.value.kind === "enum" ? bashWords(argEnum.value.values) : "";
		const fileArg = c.args.some(a => a.value.kind === "file");
		const elseBranch = argWords
			? `COMPREPLY=( $(compgen -W "${argWords}" -- "$cur") )`
			: fileArg
				? `COMPREPLY=( $(compgen -f -- "$cur") ); compopt -o filenames`
				: ":";
		parts.push(`_omp_cmd_${bashFn(c.name)}() {
	case "$prev" in
${bashFlagCase(bin, c.flags)}
	esac
	if [[ "$cur" == -* ]]; then
		COMPREPLY=( $(compgen -W "${bashFlagWords(c.flags)}" -- "$cur") )
	else
		${elseBranch}
	fi
}`);
		parts.push("");
	}

	// Dispatcher.
	const dispatch: string[] = [];
	for (const c of spec.commands) {
		dispatch.push(`\t\t${commandTokens(c).join("|")})\n\t\t\t_omp_cmd_${bashFn(c.name)}\n\t\t\t;;`);
	}
	parts.push(`_omp() {
	local cur prev cmd i
	cur="\${COMP_WORDS[COMP_CWORD]}"
	prev="\${COMP_WORDS[COMP_CWORD-1]}"
	cmd=""
	for (( i=1; i < COMP_CWORD; i++ )); do
		case "\${COMP_WORDS[i]}" in
			-*) ;;
			*) cmd="\${COMP_WORDS[i]}"; break ;;
		esac
	done
	case "$cmd" in
${dispatch.join("\n")}
		*) _omp_root ;;
	esac
}
complete -F _omp ${bin}`);
	parts.push("");
	return `${parts.join("\n")}\n`;
}

function bashFn(name: string): string {
	return name.replace(/[^A-Za-z0-9]/g, "_");
}

// --- zsh ----------------------------------------------------------------------

/** Sanitize a description for embedding in a single-quoted zsh `_arguments` spec. */
function zshDesc(s: string): string {
	return s
		.replace(/'/g, "’")
		.replace(/\[/g, "(")
		.replace(/\]/g, ")")
		.replace(/[\r\n]+/g, " ")
		.replace(/:/g, " ")
		.trim();
}

function zshAction(v: ValueSource): string {
	switch (v.kind) {
		case "flag":
			return "";
		case "value":
			return ":value:";
		case "enum":
			return `:value:(${v.values.join(" ")})`;
		case "list":
			return ":value:_omp_tools";
		case "models":
			return v.multiple ? ":models:_omp_models_list" : ":model:_omp_call models";
		case "sessions":
			return ":session:_omp_call sessions";
		case "file":
			return ":file:_files";
		case "dir":
			return ":dir:_files -/";
	}
}

function zshFlagSpec(f: CompletionFlag): string {
	const body = `[${zshDesc(f.description)}]${zshAction(f.value)}`;
	if (f.char && f.repeatable) return `'*'{-${f.char},--${f.name}}'${body}'`;
	if (f.char) return `'(-${f.char} --${f.name})'{-${f.char},--${f.name}}'${body}'`;
	if (f.repeatable) return `'*--${f.name}${body}'`;
	return `'--${f.name}${body}'`;
}

function zshArgSpec(f: CompletionArg): string {
	switch (f.value.kind) {
		case "enum":
			return `':${f.name}:(${f.value.values.join(" ")})'`;
		default:
			return `':${f.name}:_files'`;
	}
}

function generateZsh(spec: CompletionSpec): string {
	const { bin } = spec;
	// The `:value:_omp_tools` action references this helper; bake its candidates
	// from the spec's `list` flag so the generator stays a pure function of its
	// input (bash/fish read `v.values` inline for the same reason).
	const listFlag = [...spec.root.flags, ...spec.commands.flatMap(c => c.flags)].find(f => f.value.kind === "list");
	const toolNames = listFlag?.value.kind === "list" ? listFlag.value.values.join(" ") : "";
	const parts: string[] = [];
	parts.push(`#compdef ${bin}`);
	parts.push(`# zsh completion for ${bin} — generated by \`${bin} completions zsh\``);
	parts.push("");

	// Dynamic helpers (single source: `<bin> __complete <kind>` → value<TAB>desc).
	parts.push(`_omp_call() {
	local kind=$1
	local -a items
	local line
	for line in "\${(@f)$(command ${bin} __complete $kind -- "$PREFIX" 2>/dev/null)}"; do
		[[ -z $line ]] && continue
		items+=( "\${line//$'\\t'/:}" )
	done
	_describe -t "$kind" "$kind" items
}
_omp_models_list() {
	local -a items
	local line
	for line in "\${(@f)$(command ${bin} __complete models 2>/dev/null)}"; do
		[[ -z $line ]] && continue
		items+=( "\${line%%$'\\t'*}" )
	done
	_values -s , 'models' $items
}
_omp_tools() { _values -s , 'tools' ${toolNames} }`);
	parts.push("");

	// Subcommand description table.
	const cmdRows = spec.commands.map(c => `\t\t'${c.name}:${zshDesc(c.description)}'`).join("\n");
	parts.push(`_omp_commands() {
	local -a commands
	commands=(
${cmdRows}
	)
	_describe -t commands 'command' commands
}`);
	parts.push("");

	// Per-subcommand argument functions.
	for (const c of spec.commands) {
		const specs = ["'(-h --help)'{-h,--help}'[Show help]'", ...c.flags.map(zshFlagSpec), ...c.args.map(zshArgSpec)];
		parts.push(`_omp_cmd_${bashFn(c.name)}() {
	_arguments -s \\
		${specs.join(" \\\n\t\t")}
}`);
		parts.push("");
	}

	// Top-level dispatch.
	const aliasArms = spec.commands
		.map(c => `\t\t\t${commandTokens(c).join("|")}) _omp_cmd_${bashFn(c.name)} ;;`)
		.join("\n");
	const rootSpecs = [
		"'(-h --help)'{-h,--help}'[Show help]'",
		"'(-v --version)'{-v,--version}'[Show version]'",
		...spec.root.flags.map(zshFlagSpec),
		"'1: :_omp_commands'",
		"'*::arg:->args'",
	];
	parts.push(`_omp() {
	local curcontext="$curcontext" state line
	typeset -A opt_args
	_arguments -C -s \\
		${rootSpecs.join(" \\\n\t\t")}
	case $state in
		args)
			case $line[1] in
${aliasArms}
			esac
			;;
	esac
}
# Works both ways: autoloaded from $fpath (file named _omp) or eval'd from a
# startup file. When autoloaded, funcstack[1] is _omp and we invoke it; when
# sourced/eval'd we register it with compdef instead.
if [ "$funcstack[1]" = "_omp" ]; then
	_omp "$@"
else
	compdef _omp ${bin}
fi`);
	parts.push("");
	return `${parts.join("\n")}\n`;
}

// --- fish ---------------------------------------------------------------------

function fishDesc(s: string): string {
	return s
		.replace(/'/g, "’")
		.replace(/[\r\n]+/g, " ")
		.trim();
}

function fishValue(bin: string, v: ValueSource): string {
	switch (v.kind) {
		case "flag":
			return "";
		case "value":
			return "-x";
		case "enum":
		case "list":
			return `-x -a '${v.values.join(" ")}'`;
		case "models":
			return `-x -a '(command ${bin} __complete models -- (commandline -ct))'`;
		case "sessions":
			return `-x -a '(command ${bin} __complete sessions -- (commandline -ct))'`;
		case "file":
			return "-r -F";
		case "dir":
			return "-x -a '(__fish_complete_directories (commandline -ct))'";
	}
}

function fishFlagLine(bin: string, cond: string, f: CompletionFlag): string {
	const segs = [`complete -c ${bin}`, `-n '${cond}'`];
	if (f.char) segs.push(`-s ${f.char}`);
	segs.push(`-l ${f.name}`);
	if (f.description) segs.push(`-d '${fishDesc(f.description)}'`);
	const val = fishValue(bin, f.value);
	if (val) segs.push(val);
	return segs.join(" ");
}

function generateFish(spec: CompletionSpec): string {
	const { bin } = spec;
	const lines: string[] = [];
	lines.push(`# fish completion for ${bin} — generated by \`${bin} completions fish\``);
	lines.push("");

	const allTokens = spec.commands.flatMap(commandTokens);
	lines.push(`function __fish_omp_no_subcommand`);
	lines.push(`\tfor i in (commandline -opc)`);
	lines.push(`\t\tif contains -- $i ${allTokens.join(" ")}`);
	lines.push(`\t\t\treturn 1`);
	lines.push(`\t\tend`);
	lines.push(`\tend`);
	lines.push(`\treturn 0`);
	lines.push(`end`);
	lines.push("");

	const rootCond = "__fish_omp_no_subcommand";

	// Subcommand names.
	for (const c of spec.commands) {
		for (const token of commandTokens(c)) {
			lines.push(`complete -c ${bin} -f -n '${rootCond}' -a '${token}' -d '${fishDesc(c.description)}'`);
		}
	}
	lines.push("");

	// Top-level flags.
	for (const f of spec.root.flags) {
		lines.push(fishFlagLine(bin, rootCond, f));
	}
	lines.push("");

	// Per-subcommand flags and positional args.
	for (const c of spec.commands) {
		const cond = `__fish_seen_subcommand_from ${commandTokens(c).join(" ")}`;
		for (const f of c.flags) {
			lines.push(fishFlagLine(bin, cond, f));
		}
		// Positionals: fish conditions can't gate on position, so emit enum
		// candidates (if any) and otherwise a single file completion — never both,
		// and never duplicated across multiple file-typed positionals.
		const enumArgs = c.args.filter(a => a.value.kind === "enum");
		if (enumArgs.length > 0) {
			for (const a of enumArgs) {
				if (a.value.kind !== "enum") continue;
				lines.push(
					`complete -c ${bin} -f -n '${cond}' -a '${a.value.values.join(" ")}' -d '${fishDesc(a.description)}'`,
				);
			}
		} else if (c.args.some(a => a.value.kind === "file")) {
			lines.push(`complete -c ${bin} -F -n '${cond}'`);
		}
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}

// --- PowerShell ---------------------------------------------------------------

function psQuote(value: string): string {
	return `'${value
		.replace(/'/g, "''")
		.replace(/[\r\n]+/g, " ")
		.trim()}'`;
}

function psArray(values: readonly string[]): string {
	return `@(${values.map(psQuote).join(", ")})`;
}

function psValueSource(value: ValueSource): string {
	switch (value.kind) {
		case "flag":
			return "Kind = 'flag'";
		case "value":
			return "Kind = 'value'";
		case "enum":
			return `Kind = 'enum'; Values = ${psArray(value.values)}`;
		case "list":
			return `Kind = 'list'; Values = ${psArray(value.values)}`;
		case "models":
			return value.multiple ? "Kind = 'models-multiple'" : "Kind = 'models'";
		case "sessions":
			return "Kind = 'sessions'";
		case "file":
			return "Kind = 'file'";
		case "dir":
			return "Kind = 'dir'";
	}
}

function psFlagEntry(flag: CompletionFlag): string {
	const names = [`--${flag.name}`, ...(flag.char ? [`-${flag.char}`] : [])];
	return `@{ Names = ${psArray(names)}; Description = ${psQuote(flag.description)}; ${psValueSource(flag.value)} }`;
}

function psArgEntry(arg: CompletionArg): string {
	return `@{ Description = ${psQuote(arg.description)}; ${psValueSource(arg.value)} }`;
}

function generatePowerShell(spec: CompletionSpec): string {
	const commandEntries = spec.commands
		.map(
			c =>
				`@{ Name = ${psQuote(c.name)}; Aliases = ${psArray(c.aliases)}; Description = ${psQuote(c.description)}; Flags = @(${c.flags.map(psFlagEntry).join(", ")}); Args = @(${c.args.map(psArgEntry).join(", ")}) }`,
		)
		.join(",\n\t");
	const rootFlags = spec.root.flags.map(psFlagEntry).join(", ");
	const rootArgs = spec.root.args.map(psArgEntry).join(", ");

	return `# PowerShell completion for ${spec.bin} - generated by \`${spec.bin} completions powershell\`
$__ompCommands = @(
\t${commandEntries}
)
$__ompRootFlags = @(${rootFlags})
$__ompRootArgs = @(${rootArgs})

function __ompResult([string]$text, [string]$tooltip, [System.Management.Automation.CompletionResultType]$type) {
\tif ([string]::IsNullOrEmpty($tooltip)) { $tooltip = $text }
\tNew-Object System.Management.Automation.CompletionResult -ArgumentList @($text, $text, $type, $tooltip)
}

function __ompDynamic([string]$kind, [string]$prefix, [string]$bin) {
\t$output = & $bin __complete $kind -- $prefix 2>$null
\tforeach ($line in @($output)) {
\t\tif ([string]::IsNullOrWhiteSpace($line)) { continue }
\t\t$parts = $line -split "\`t", 2
\t\t$value = $parts[0]
\t\t$tooltip = if ($parts.Count -gt 1) { $parts[1] } else { $value }
\t\t__ompResult $value $tooltip ([System.Management.Automation.CompletionResultType]::ParameterValue)
\t}
}

function __ompFile([string]$word, [bool]$directory) {
\t$results = [System.Management.Automation.CompletionCompleters]::CompleteFilename($word)
\tforeach ($result in @($results)) {
\t\tif (-not $directory -or $result.ResultType -eq [System.Management.Automation.CompletionResultType]::ProviderContainer) {
\t\t\t$result
\t\t}
\t}
}

function __ompValues($source, [string]$word, [string]$bin) {
\t$kind = [string]$source.Kind
\tif ($kind -eq "flag" -or $kind -eq "value") { return }
\tif ($kind -eq "enum") {
\t\tforeach ($value in @($source.Values)) {
\t\t\tif ($value.StartsWith($word, [System.StringComparison]::OrdinalIgnoreCase)) {
\t\t\t\t__ompResult $value $value ([System.Management.Automation.CompletionResultType]::ParameterValue)
\t\t\t}
\t\t}
\t\treturn
\t}
\tif ($kind -eq "list") {
\t\t$prefix = ""
\t\t$current = $word
\t\t$comma = $word.LastIndexOf(",")
\t\tif ($comma -ge 0) { $prefix = $word.Substring(0, $comma + 1); $current = $word.Substring($comma + 1) }
\t\tforeach ($value in @($source.Values)) {
\t\t\tif ($value.StartsWith($current, [System.StringComparison]::OrdinalIgnoreCase)) {
\t\t\t\t__ompResult ($prefix + $value) $value ([System.Management.Automation.CompletionResultType]::ParameterValue)
\t\t\t}
\t\t}
\t\treturn
\t}
\tif ($kind -eq "models-multiple") {
\t\t$prefix = ""
\t\t$current = $word
\t\t$comma = $word.LastIndexOf(",")
\t\tif ($comma -ge 0) { $prefix = $word.Substring(0, $comma + 1); $current = $word.Substring($comma + 1) }
\t\tforeach ($result in @(__ompDynamic "models" $current $bin)) {
\t\t\t__ompResult ($prefix + $result.CompletionText) $result.ToolTip ([System.Management.Automation.CompletionResultType]::ParameterValue)
\t\t}
\t\treturn
\t}
\tif ($kind -eq "models" -or $kind -eq "sessions") {
\t\t__ompDynamic $kind $word $bin
\t\treturn
\t}
\tif ($kind -eq "file") { __ompFile $word $false; return }
\tif ($kind -eq "dir") { __ompFile $word $true; return }
}

Register-ArgumentCompleter -Native -CommandName @(${psQuote(spec.bin)}, ${psQuote(`${spec.bin}.exe`)}) -ScriptBlock {
\tparam($wordToComplete, $commandAst, $cursorPosition)
\t$wordToComplete = [string]$wordToComplete
\t$elements = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text.Trim([char]39, [char]34) })
\t$bin = $elements[0]
\t$tokens = @($elements | Select-Object -Skip 1)
\tif ($tokens.Count -gt 0 -and $tokens[$tokens.Count - 1] -eq $wordToComplete) {
\t\t$tokens = @($tokens | Select-Object -SkipLast 1)
\t}
\t$subcommand = $null
\tforeach ($token in $tokens) {
\t\tif (-not $token.StartsWith("-")) { $subcommand = $token; break }
\t}
\t$scope = $__ompRootFlags
\t$positionalArgs = $__ompRootArgs
\t$command = $null
\tif ($subcommand) {
\t\t$command = @($__ompCommands | Where-Object { $_.Name -eq $subcommand -or $_.Aliases -contains $subcommand })[0]
\t\tif ($command) { $scope = $command.Flags; $positionalArgs = $command.Args }
\t}
\t$previous = if ($tokens.Count -gt 0) { $tokens[$tokens.Count - 1] } else { "" }
\tforeach ($flag in @($scope)) {
\t\tif ($flag.Names -contains $previous) {
\t\t\t__ompValues $flag $wordToComplete $bin
\t\t\treturn
\t\t}
\t}
\tif ($wordToComplete.StartsWith("-")) {
\t\tforeach ($flag in @($scope)) {
\t\t\tforeach ($name in $flag.Names) {
\t\t\t\tif ($name.StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase)) {
\t\t\t\t\t__ompResult $name $flag.Description ([System.Management.Automation.CompletionResultType]::ParameterName)
\t\t\t\t}
\t\t\t}
\t\t}
\t\treturn
\t}
\tif (-not $subcommand) {
\t\tforeach ($candidate in @($__ompCommands)) {
\t\t\tif ($candidate.Name.StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase)) {
\t\t\t\t__ompResult $candidate.Name $candidate.Description ([System.Management.Automation.CompletionResultType]::Command)
\t\t\t}
\t\t\tforeach ($alias in @($candidate.Aliases)) {
\t\t\t\tif ($alias.StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase)) {
\t\t\t\t\t__ompResult $alias $candidate.Description ([System.Management.Automation.CompletionResultType]::Command)
\t\t\t\t}
\t\t\t}
\t\t}
\t\treturn
\t}
\t$position = 0
\t$skipValue = $false
\tforeach ($token in $tokens) {
\t\tif ($token -eq $subcommand) { continue }
\t\tif ($skipValue) { $skipValue = $false; continue }
\t\tif ($token.StartsWith("-")) {
\t\t\t$valueFlag = @($scope | Where-Object { $_.Names -contains $token })[0]
\t\t\tif ($valueFlag -and $valueFlag.Kind -ne "flag") { $skipValue = $true }
\t\t\tcontinue
\t\t}
\t\t$position++
\t}
\tif ($positionalArgs.Count -gt $position) {
\t\t$arg = $positionalArgs[$position]
\t\tif ($arg.Kind -eq "enum") {
\t\t\tforeach ($value in @($arg.Values)) {
\t\t\t\tif ($value.StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase)) {
\t\t\t\t\t__ompResult $value $arg.Description ([System.Management.Automation.CompletionResultType]::ParameterValue)
\t\t\t\t}
\t\t\t}
\t\t} elseif ($arg.Kind -eq "file") {
\t\t\t__ompFile $wordToComplete $false
\t\t}
\t}
}
`;
}
