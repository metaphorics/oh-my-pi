import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const kiroProvider = {
	id: "kiro",
	name: "Kiro",
	login: async (callbacks: OAuthLoginCallbacks) => {
		const { loginKiro } = await import("./oauth/kiro");
		return loginKiro(callbacks);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		const { refreshKiroToken } = await import("./oauth/kiro");
		return refreshKiroToken(credentials);
	},
	getApiKey: (credentials: OAuthCredentials) =>
		JSON.stringify({ accessToken: credentials.access, profileArn: credentials.profileArn }),
} as const satisfies ProviderDefinition;
