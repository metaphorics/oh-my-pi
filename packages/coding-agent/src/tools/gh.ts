import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import githubDescription from "../prompts/tools/github.md" with { type: "text" };
import * as git from "../utils/git";
import type { ToolSession } from ".";
import { executePrCheckout, executePrCreate, executePrPush, executeRepoView } from "./gh-pr";
import { executeRunWatch } from "./gh-run";
import {
	executeSearchCode,
	executeSearchCommits,
	executeSearchIssues,
	executeSearchPrs,
	executeSearchRepos,
} from "./gh-search";
import { type GhToolDetails, type GithubInput, githubSchema } from "./gh-shared";

export {
	getOrFetchIssue,
	getOrFetchPr,
	getOrFetchPrDiff,
	githubIssueJsonWithStateReasonFallback,
	type IssueViewLookupOptions,
	type PrDiffFile,
	type PrDiffLookupOptions,
	type PrDiffPayload,
	type PrViewLookupOptions,
	parsePositiveDecimalInt,
	parsePrUnifiedDiff,
	type ViewLookupResult,
} from "./gh-pr";
export { buildSearchDateQualifier, parseSearchDateBound } from "./gh-search";
export {
	type GhPrCheckoutSummary,
	type GhRunWatchFailedLogDetails,
	type GhRunWatchJobDetails,
	type GhRunWatchRunDetails,
	type GhRunWatchViewDetails,
	type GhToolDetails,
	resolveDefaultRepoMemoized,
} from "./gh-shared";

const GITHUB_READONLY_OPS: ReadonlySet<string> = new Set([
	"repo_view",
	"search_issues",
	"search_prs",
	"search_code",
	"search_commits",
	"search_repos",
	"run_watch",
]);

export class GithubTool implements AgentTool<typeof githubSchema, GhToolDetails> {
	readonly name = "github";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawOp = (args as Partial<GithubInput>).op;
		const op = typeof rawOp === "string" ? rawOp : "";
		return GITHUB_READONLY_OPS.has(op) ? "read" : "exec";
	};
	readonly summary = "Interact with GitHub issues, pull requests, and repositories";
	readonly loadMode = "discoverable";
	readonly label = "GitHub";
	readonly description = prompt.render(githubDescription);
	readonly parameters = githubSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): GithubTool | null {
		if (!git.github.available()) return null;
		return new GithubTool(session);
	}

	async execute(
		_toolCallId: string,
		params: GithubInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<GhToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GhToolDetails>> {
		return untilAborted(signal, async () => {
			switch (params.op) {
				case "repo_view":
					return executeRepoView(this.session, params, signal);
				case "pr_create":
					return executePrCreate(this.session, params, signal);
				case "pr_checkout":
					return executePrCheckout(this.session, params, signal);
				case "pr_push":
					return executePrPush(this.session, params, signal);
				case "search_issues":
					return executeSearchIssues(this.session, params, signal);
				case "search_prs":
					return executeSearchPrs(this.session, params, signal);
				case "search_code":
					return executeSearchCode(this.session, params, signal);
				case "search_commits":
					return executeSearchCommits(this.session, params, signal);
				case "search_repos":
					return executeSearchRepos(this.session, params, signal);
				case "run_watch":
					return executeRunWatch(this.session, this.name, params, signal, onUpdate);
			}
		});
	}
}
