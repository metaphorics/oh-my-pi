import { parseKiroCredentials } from "@oh-my-pi/pi-catalog/discovery/kiro";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { UsageLimit, UsageProvider, UsageReport, UsageStatus } from "../usage";

const DEFAULT_REGION = "us-east-1";
const GET_USAGE_TARGET = "AmazonCodeWhispererService.GetUsageLimits";

export function parseKiroUsage(payload: unknown, profileArn?: string, fetchedAt = Date.now()): UsageReport | null {
	if (!isRecord(payload) || !Array.isArray(payload.usageBreakdownList)) return null;
	const resetsAt = epochMilliseconds(payload.nextDateReset);
	const limits: UsageLimit[] = [];
	for (const entry of payload.usageBreakdownList) {
		if (!isRecord(entry)) continue;
		const resourceType = typeof entry.resourceType === "string" ? entry.resourceType : "usage";
		const used = finiteNumber(entry.currentUsageWithPrecision) ?? finiteNumber(entry.currentUsage);
		const limit = finiteNumber(entry.usageLimitWithPrecision) ?? finiteNumber(entry.usageLimit);
		if (used === undefined || limit === undefined) continue;
		const usedFraction = limit > 0 ? used / limit : 0;
		const status: UsageStatus = usedFraction >= 1 ? "exhausted" : usedFraction >= 0.9 ? "warning" : "ok";
		const window = { id: "subscription", label: "Subscription", ...(resetsAt ? { resetsAt } : undefined) };
		limits.push({
			id: `kiro:${resourceType.toLowerCase()}`,
			label:
				typeof entry.displayNamePlural === "string" && entry.displayNamePlural
					? entry.displayNamePlural
					: resourceType,
			scope: { provider: "kiro", windowId: window.id },
			window,
			amount: {
				used,
				limit,
				remaining: Math.max(0, limit - used),
				usedFraction,
				remainingFraction: limit > 0 ? Math.max(0, limit - used) / limit : 0,
				unit: "requests",
			},
			status,
		});
	}
	if (limits.length === 0) return null;
	return {
		provider: "kiro",
		fetchedAt,
		limits,
		metadata: profileArn ? { profileArn } : undefined,
		raw: payload,
	};
}

export const kiroUsageProvider: UsageProvider = {
	id: "kiro",
	supports: params =>
		params.provider === "kiro" &&
		Boolean(params.credential.type === "oauth" ? params.credential.accessToken : params.credential.apiKey),
	async fetchUsage(params, ctx) {
		if (params.provider !== "kiro") return null;
		const rawToken = params.credential.type === "oauth" ? params.credential.accessToken : params.credential.apiKey;
		const credentials = parseKiroCredentials(rawToken, params.credential.profileArn);
		if (!credentials) return null;
		const profileRegion = credentials.profileArn?.split(":")[3];
		const region = profileRegion || DEFAULT_REGION;
		const url = new URL(`https://management.${region}.kiro.dev/`);
		url.searchParams.set("origin", "KIRO_CLI");
		if (credentials.profileArn) url.searchParams.set("profileArn", credentials.profileArn);
		try {
			const response = await ctx.fetch(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${credentials.accessToken}`,
					"content-type": "application/x-amz-json-1.0",
					"x-amz-target": GET_USAGE_TARGET,
				},
				body: JSON.stringify({
					origin: "KIRO_CLI",
					...(credentials.profileArn ? { profileArn: credentials.profileArn } : undefined),
				}),
				signal: params.signal,
			});
			if (!response.ok) return null;
			return parseKiroUsage(await response.json(), credentials.profileArn);
		} catch (error) {
			ctx.logger?.warn("Kiro usage request failed", { error: String(error) });
			return null;
		}
	},
};

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function epochMilliseconds(value: unknown): number | undefined {
	const seconds = finiteNumber(value);
	return seconds === undefined ? undefined : seconds < 1_000_000_000_000 ? seconds * 1_000 : seconds;
}
