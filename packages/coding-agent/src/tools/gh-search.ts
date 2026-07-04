import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import * as git from "../utils/git";
import type { ToolSession } from ".";
import { formatShortSha } from "./gh-format";
import {
	buildTextResult,
	formatAuthor,
	formatLabels,
	type GhLabel,
	type GhToolDetails,
	type GhUser,
	type GithubInput,
	normalizeOptionalString,
	normalizeText,
	pushLine,
	requireNonEmpty,
	resolveDefaultRepoMemoized,
} from "./gh-shared";
import { ToolError } from "./tool-errors";

// /search/<endpoint> API response shapes (subset). Used when projecting raw
// REST results into the normalized `GhSearch*Result` shapes the formatters
// consume. We talk to the API directly because `gh search prs`/`issues`
// quotes multi-token positional queries (`is:"merged is:pr"`) and returns 0
// hits — see https://github.com/cli/cli for the upstream regression.
interface GhApiSearchResponse<T> {
	total_count?: number;
	incomplete_results?: boolean;
	items?: T[];
}

interface GhApiUser {
	login?: string;
	name?: string | null;
}

interface GhApiLabel {
	name?: string;
}

interface GhApiPullRequestRef {
	merged_at?: string | null;
}

interface GhApiSearchIssueItem {
	number?: number;
	title?: string;
	state?: string;
	state_reason?: string | null;
	user?: GhApiUser | null;
	labels?: GhApiLabel[];
	created_at?: string;
	updated_at?: string;
	html_url?: string;
	repository_url?: string;
	pull_request?: GhApiPullRequestRef | null;
}

interface GhApiSearchCodeItem {
	name?: string;
	path?: string;
	sha?: string;
	html_url?: string;
	repository?: { full_name?: string } | null;
	text_matches?: Array<{ fragment?: string; property?: string }>;
}

interface GhApiSearchCommitGitActor {
	name?: string;
	email?: string;
	date?: string;
}

interface GhApiSearchCommitItem {
	sha?: string;
	node_id?: string;
	html_url?: string;
	author?: GhApiUser | null;
	committer?: GhApiUser | null;
	commit?: {
		author?: GhApiSearchCommitGitActor | null;
		committer?: GhApiSearchCommitGitActor | null;
		message?: string;
	} | null;
	repository?: { full_name?: string } | null;
}

interface GhApiSearchRepoItem {
	full_name?: string;
	description?: string | null;
	language?: string | null;
	stargazers_count?: number;
	forks_count?: number;
	open_issues_count?: number;
	archived?: boolean;
	fork?: boolean;
	private?: boolean;
	visibility?: string | null;
	updated_at?: string;
	created_at?: string;
	html_url?: string;
	owner?: GhApiUser | null;
}

const SEARCH_LIMIT_DEFAULT = 10;

const SEARCH_LIMIT_MAX = 50;

interface GhSearchRepository {
	nameWithOwner?: string;
}

interface GhSearchResult {
	author?: GhUser | null;
	createdAt?: string;
	labels?: GhLabel[];
	number?: number;
	repository?: GhSearchRepository | null;
	state?: string;
	title?: string;
	updatedAt?: string;
	url?: string;
}

interface GhSearchCodeTextMatch {
	fragment?: string;
	property?: string;
}

interface GhSearchCodeResult {
	path?: string;
	repository?: GhSearchRepository | null;
	sha?: string;
	textMatches?: GhSearchCodeTextMatch[];
	url?: string;
}

interface GhSearchCommitGitActor {
	name?: string;
	email?: string;
	date?: string;
}

interface GhSearchCommitDetail {
	author?: GhSearchCommitGitActor | null;
	committer?: GhSearchCommitGitActor | null;
	message?: string;
}

interface GhSearchCommitResult {
	author?: GhUser | null;
	commit?: GhSearchCommitDetail | null;
	committer?: GhUser | null;
	id?: string;
	repository?: GhSearchRepository | null;
	sha?: string;
	url?: string;
}

interface GhSearchRepoResult {
	createdAt?: string;
	description?: string | null;
	forksCount?: number;
	fullName?: string;
	isArchived?: boolean;
	isFork?: boolean;
	isPrivate?: boolean;
	language?: string | null;
	openIssuesCount?: number;
	owner?: GhUser | null;
	stargazersCount?: number;
	updatedAt?: string;
	url?: string;
	visibility?: string | null;
}

function resolveSearchLimit(value: number | undefined): number {
	if (value === undefined) {
		return SEARCH_LIMIT_DEFAULT;
	}

	if (!Number.isFinite(value) || value <= 0) {
		throw new ToolError("limit must be a positive number");
	}

	return Math.min(Math.floor(value), SEARCH_LIMIT_MAX);
}

const REPO_API_URL_PREFIX = "https://api.github.com/repos/";

const RELATIVE_DURATION_PATTERN = /^(\d+)\s*(m|h|d|w|mo|y)$/i;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const FIXED_UNIT_MS: Record<string, number> = {
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 7 * 86_400_000,
};

/**
 * Resolve a search date bound to a GitHub-search-compatible literal. Returns
 * either a `YYYY-MM-DD` date (relative durations and date-only inputs) or a
 * full ISO 8601 datetime string (datetime inputs), so the caller can drop it
 * straight into a qualifier like `created:>=<value>`.
 */
export function parseSearchDateBound(raw: string, now: Date = new Date()): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		throw new ToolError("date bound must not be empty");
	}

	const relMatch = trimmed.match(RELATIVE_DURATION_PATTERN);
	if (relMatch) {
		const count = Number(relMatch[1]);
		const unit = relMatch[2].toLowerCase();
		const fixedMs = FIXED_UNIT_MS[unit];
		let bound: Date;
		if (fixedMs !== undefined) {
			bound = new Date(now.getTime() - count * fixedMs);
		} else {
			bound = new Date(now);
			if (unit === "mo") {
				bound.setUTCMonth(bound.getUTCMonth() - count);
			} else {
				bound.setUTCFullYear(bound.getUTCFullYear() - count);
			}
		}
		return bound.toISOString().slice(0, 10);
	}

	if (ISO_DATE_PATTERN.test(trimmed)) {
		return trimmed;
	}

	const parsedMs = Date.parse(trimmed);
	if (!Number.isNaN(parsedMs)) {
		// GitHub search qualifiers accept seconds precision only
		// (`YYYY-MM-DDTHH:MM:SSZ`); strip the milliseconds toISOString emits.
		return new Date(parsedMs).toISOString().replace(/\.\d{3}Z$/, "Z");
	}

	throw new ToolError(
		`invalid date bound: ${raw}. Expected a relative duration like "3d", "12h", "2w", an ISO date "YYYY-MM-DD", or an ISO datetime.`,
	);
}

/**
 * Build the GitHub-search qualifier (e.g. `created:>=2026-05-09`) for the
 * provided bounds, or `undefined` if neither bound is set.
 */
export function buildSearchDateQualifier(
	field: string,
	since: string | undefined,
	until: string | undefined,
	now?: Date,
): string | undefined {
	const sinceVal = since ? parseSearchDateBound(since, now) : undefined;
	const untilVal = until ? parseSearchDateBound(until, now) : undefined;
	if (sinceVal && untilVal) {
		return `${field}:${sinceVal}..${untilVal}`;
	}
	if (sinceVal) {
		return `${field}:>=${sinceVal}`;
	}
	if (untilVal) {
		return `${field}:<=${untilVal}`;
	}
	return undefined;
}

function resolveSearchDateField(
	command: "issues" | "prs" | "commits" | "repos",
	requested: "created" | "updated" | undefined,
): string {
	if (command === "commits") {
		return "committer-date";
	}
	const dateField = requested ?? "created";
	if (command === "repos" && dateField === "updated") {
		return "pushed";
	}
	return dateField;
}

function composeSearchQuery(parts: ReadonlyArray<string | undefined>): string {
	const cleaned: string[] = [];
	for (const part of parts) {
		const trimmed = part?.trim();
		if (trimmed) cleaned.push(trimmed);
	}
	if (cleaned.length === 0) {
		throw new ToolError("query is required (or pass since/until to filter by date)");
	}
	return cleaned.join(" ");
}

function buildGhApiSearchArgs(
	endpoint: "issues" | "code" | "commits" | "repositories",
	query: string,
	limit: number,
	extraHeaders?: ReadonlyArray<string>,
): string[] {
	const args = ["api", "-X", "GET", `/search/${endpoint}`, "-f", `q=${query}`, "-F", `per_page=${limit}`];
	for (const header of extraHeaders ?? []) {
		args.push("-H", header);
	}
	return args;
}

function repoFromRepositoryUrl(value: string | undefined): string | undefined {
	if (!value?.startsWith(REPO_API_URL_PREFIX)) return undefined;
	return value.slice(REPO_API_URL_PREFIX.length);
}

function apiUserToGhUser(user: GhApiUser | null | undefined): GhUser | undefined {
	if (!user) return undefined;
	const login = user.login ?? undefined;
	const name = user.name ?? undefined;
	if (login === undefined && name === undefined) return undefined;
	return { login, name };
}

function apiLabelsToGhLabels(labels: GhApiLabel[] | undefined): GhLabel[] {
	return labels?.map(label => ({ name: label.name })) ?? [];
}

function apiIssueToSearchResult(item: GhApiSearchIssueItem): GhSearchResult {
	const merged = Boolean(item.pull_request?.merged_at);
	return {
		author: apiUserToGhUser(item.user) ?? null,
		createdAt: item.created_at,
		labels: apiLabelsToGhLabels(item.labels),
		number: item.number,
		repository: { nameWithOwner: repoFromRepositoryUrl(item.repository_url) },
		state: merged ? "merged" : item.state,
		title: item.title,
		updatedAt: item.updated_at,
		url: item.html_url,
	};
}

function apiCodeToSearchResult(item: GhApiSearchCodeItem): GhSearchCodeResult {
	return {
		path: item.path,
		repository: { nameWithOwner: item.repository?.full_name },
		sha: item.sha,
		textMatches: item.text_matches?.map(match => ({ fragment: match.fragment, property: match.property })),
		url: item.html_url,
	};
}

function apiCommitToSearchResult(item: GhApiSearchCommitItem): GhSearchCommitResult {
	return {
		author: apiUserToGhUser(item.author) ?? null,
		commit: item.commit
			? {
					author: item.commit.author ?? null,
					committer: item.commit.committer ?? null,
					message: item.commit.message,
				}
			: null,
		committer: apiUserToGhUser(item.committer) ?? null,
		id: item.node_id,
		repository: { nameWithOwner: item.repository?.full_name },
		sha: item.sha,
		url: item.html_url,
	};
}

function apiRepoToSearchResult(item: GhApiSearchRepoItem): GhSearchRepoResult {
	return {
		createdAt: item.created_at,
		description: item.description,
		forksCount: item.forks_count,
		fullName: item.full_name,
		isArchived: item.archived,
		isFork: item.fork,
		isPrivate: item.private,
		language: item.language,
		openIssuesCount: item.open_issues_count,
		owner: apiUserToGhUser(item.owner) ?? null,
		stargazersCount: item.stargazers_count,
		updatedAt: item.updated_at,
		url: item.html_url,
		visibility: item.visibility ?? null,
	};
}

/**
 * Best-effort cached cwd → `owner/repo` resolution that swallows any failure
 * (not a git checkout, no GitHub remote, `gh` unauthenticated, …) into
 * `undefined`. Use where the cwd repo is a convenience fallback, not a safety
 * check.
 */
async function tryResolveCurrentRepo(cwd: string, signal: AbortSignal | undefined): Promise<string | undefined> {
	try {
		return await resolveDefaultRepoMemoized(cwd, signal);
	} catch {
		return undefined;
	}
}

/**
 * Matches search-query qualifiers that already scope to a repository, org, or
 * user. When present, callers should avoid layering a default `repo:<current>`
 * on top — the user has already expressed an explicit scope.
 *
 * Only the leading `repo:`/`org:`/`user:`/`owner:` token is treated as a
 * scope marker; arbitrary substrings (e.g. inside quoted text) are ignored.
 */
const REPO_SCOPE_QUALIFIER_PATTERN = /(?:^|\s)-?(?:repo|org|user|owner):\S/i;

/**
 * Resolve the effective `repo:` scope for a search op. Returns the explicit
 * `repo` when set, `undefined` when the query already carries a scoping
 * qualifier, and otherwise the current checkout's `owner/repo` via
 * `resolveDefaultRepoMemoized`. Resolution failures (no git/gh context, no
 * configured remote) silently fall back to `undefined` so the search proceeds
 * across all of GitHub instead of throwing.
 */
async function resolveSearchRepoScope(
	cwd: string,
	repo: string | undefined,
	query: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	if (repo) return repo;
	if (query && REPO_SCOPE_QUALIFIER_PATTERN.test(query)) return undefined;
	return tryResolveCurrentRepo(cwd, signal);
}

function formatSearchResults(
	kind: "issues" | "pull requests",
	query: string,
	repo: string | undefined,
	items: GhSearchResult[],
): string {
	const lines: string[] = [`# GitHub ${kind} search`, "", `Query: ${query}`];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push(`No ${kind} found.`);
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		lines.push(`- #${item.number ?? "?"} ${item.title ?? "Untitled"}`);
		pushLine(lines, "  Repo", item.repository?.nameWithOwner);
		pushLine(lines, "  State", item.state);
		pushLine(lines, "  Author", formatAuthor(item.author));
		pushLine(lines, "  Labels", formatLabels(item.labels));
		pushLine(lines, "  Created", item.createdAt);
		pushLine(lines, "  Updated", item.updatedAt);
		pushLine(lines, "  URL", item.url);
	}

	return lines.join("\n").trim();
}

function formatSearchCodeResults(query: string, repo: string | undefined, items: GhSearchCodeResult[]): string {
	const lines: string[] = [`# GitHub code search`, "", `Query: ${query}`];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push("No code matches found.");
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		lines.push(`- ${item.path ?? "(unknown path)"}`);
		pushLine(lines, "  Repo", item.repository?.nameWithOwner);
		pushLine(lines, "  Commit", formatShortSha(item.sha));
		pushLine(lines, "  URL", item.url);
		const fragment = item.textMatches?.find(match => match.fragment)?.fragment;
		if (fragment) {
			pushLine(lines, "  Match", normalizeText(fragment).split("\n", 1)[0]);
		}
	}

	return lines.join("\n").trim();
}

function formatSearchCommitMessage(message: string | undefined): string | undefined {
	if (!message) return undefined;
	const firstLine = normalizeText(message).split("\n", 1)[0];
	return firstLine || undefined;
}

function formatSearchCommitsResults(query: string, repo: string | undefined, items: GhSearchCommitResult[]): string {
	const lines: string[] = [`# GitHub commits search`, "", `Query: ${query}`];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push("No commits found.");
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		const sha = formatShortSha(item.sha) ?? "(unknown sha)";
		const subject = formatSearchCommitMessage(item.commit?.message) ?? "(no commit message)";
		lines.push(`- ${sha} ${subject}`);
		pushLine(lines, "  Repo", item.repository?.nameWithOwner);
		pushLine(lines, "  Author", formatAuthor(item.author) ?? item.commit?.author?.name);
		pushLine(lines, "  Date", item.commit?.author?.date ?? item.commit?.committer?.date);
		pushLine(lines, "  URL", item.url);
	}

	return lines.join("\n").trim();
}

function formatSearchReposResults(query: string, items: GhSearchRepoResult[]): string {
	const lines: string[] = [`# GitHub repositories search`, "", `Query: ${query}`];
	pushLine(lines, "Results", items.length);

	if (items.length === 0) {
		lines.push("");
		lines.push("No repositories found.");
		return lines.join("\n").trim();
	}

	for (const item of items) {
		lines.push("");
		lines.push(`- ${item.fullName ?? "(unknown repository)"}`);
		const description = normalizeText(item.description).split("\n", 1)[0];
		if (description) {
			pushLine(lines, "  Description", description);
		}
		pushLine(lines, "  Language", item.language ?? undefined);
		pushLine(lines, "  Stars", item.stargazersCount);
		pushLine(lines, "  Forks", item.forksCount);
		pushLine(lines, "  Open issues", item.openIssuesCount);
		pushLine(lines, "  Visibility", item.visibility ?? undefined);
		pushLine(lines, "  Archived", item.isArchived);
		pushLine(lines, "  Fork", item.isFork);
		pushLine(lines, "  Updated", item.updatedAt);
		pushLine(lines, "  URL", item.url);
	}

	return lines.join("\n").trim();
}

export async function executeSearchIssues(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("issues", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const displayQuery = composeSearchQuery([params.query, dateQualifier]);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), displayQuery, signal);
	const apiQuery = composeSearchQuery([displayQuery, repo ? `repo:${repo}` : undefined, "is:issue"]);
	const args = buildGhApiSearchArgs("issues", apiQuery, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchIssueItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiIssueToSearchResult);
	return buildTextResult(formatSearchResults("issues", displayQuery, repo, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

export async function executeSearchPrs(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("prs", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const displayQuery = composeSearchQuery([params.query, dateQualifier]);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), displayQuery, signal);
	const apiQuery = composeSearchQuery([displayQuery, repo ? `repo:${repo}` : undefined, "is:pr"]);
	const args = buildGhApiSearchArgs("issues", apiQuery, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchIssueItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiIssueToSearchResult);
	return buildTextResult(formatSearchResults("pull requests", displayQuery, repo, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

export async function executeSearchCode(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const query = requireNonEmpty(params.query, "query");
	if (params.since !== undefined || params.until !== undefined) {
		throw new ToolError("search_code does not support since/until; GitHub code search has no date qualifier.");
	}
	const limit = resolveSearchLimit(params.limit);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), query, signal);
	const apiQuery = composeSearchQuery([query, repo ? `repo:${repo}` : undefined]);
	const args = buildGhApiSearchArgs("code", apiQuery, limit, ["Accept: application/vnd.github.text-match+json"]);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchCodeItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiCodeToSearchResult);
	return buildTextResult(formatSearchCodeResults(query, repo, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

export async function executeSearchCommits(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("commits", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const displayQuery = composeSearchQuery([params.query, dateQualifier]);
	const repo = await resolveSearchRepoScope(session.cwd, normalizeOptionalString(params.repo), displayQuery, signal);
	const apiQuery = composeSearchQuery([displayQuery, repo ? `repo:${repo}` : undefined]);
	const args = buildGhApiSearchArgs("commits", apiQuery, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchCommitItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiCommitToSearchResult);
	return buildTextResult(formatSearchCommitsResults(displayQuery, repo, items), undefined, undefined, {
		useless: items.length === 0,
	});
}

export async function executeSearchRepos(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const limit = resolveSearchLimit(params.limit);
	const dateField = resolveSearchDateField("repos", params.dateField);
	const dateQualifier = buildSearchDateQualifier(dateField, params.since, params.until);
	const query = composeSearchQuery([params.query, dateQualifier]);
	const args = buildGhApiSearchArgs("repositories", query, limit);

	const response = await git.github.json<GhApiSearchResponse<GhApiSearchRepoItem>>(session.cwd, args, signal);
	const items = (response.items ?? []).map(apiRepoToSearchResult);
	return buildTextResult(formatSearchReposResults(query, items), undefined, undefined, {
		useless: items.length === 0,
	});
}
