import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const kiroProvider = {
	id: "kiro",
	// OAuth flow stays lazy to avoid adding its device-code machinery to CLI startup.
	name: "Kiro",
	login: async (callbacks: OAuthLoginCallbacks) => {
		const { loginKiro } = await import("./oauth/kiro");
		return loginKiro(callbacks);
	},
	refreshToken: async credentials => {
		const { refreshKiro } = await import("./oauth/kiro");
		return refreshKiro(credentials);
	},
} as const satisfies ProviderDefinition;
