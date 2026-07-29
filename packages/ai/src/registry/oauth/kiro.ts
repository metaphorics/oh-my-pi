import { isRecord } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import { pollOAuthDeviceCodeFlow, type OAuthDeviceCodePollResult } from "./device-code";
import type { OAuthController, OAuthCredentials } from "./types";

const KIRO_AUTH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev";
const KIRO_AUTH_TARGET_PREFIX = "KiroAuthService.";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REFRESH_GRANT = "refresh_token";
const KIRO_CLIENT_NAME = "Oh My Pi";
const KIRO_START_URL = "https://kiro.dev";

type KiroClientRegistration = {
	clientId: string;
	clientSecret: string;
	expiresAt: number;
};

type KiroDeviceAuthorization = {
	deviceCode: string;
	userCode: string;
	verificationUriComplete: string;
	expiresInSeconds: number;
	intervalSeconds: number;
};

export async function loginKiro(ctrl: OAuthController): Promise<OAuthCredentials> {
	const fetchImpl = ctrl.fetch ?? fetch;
	const registration = await registerClient(fetchImpl, ctrl.signal);
	const device = await startDeviceAuthorization(registration, fetchImpl, ctrl.signal);
	ctrl.onAuth?.({
		url: device.verificationUriComplete,
		instructions: `Enter code: ${device.userCode}`,
	});
	ctrl.onProgress?.("Waiting for Kiro device authorization...");
	return pollOAuthDeviceCodeFlow({
		poll: () => pollKiroDeviceToken(registration, device.deviceCode, fetchImpl, ctrl.signal),
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		signal: ctrl.signal,
	});
}

export async function refreshKiro(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const registration = await registerClient(fetch);
	const payload = await postKiroAuth(
		"CreateToken",
		{
			clientId: registration.clientId,
			clientSecret: registration.clientSecret,
			grantType: REFRESH_GRANT,
			refreshToken: credentials.refresh,
		},
		fetch,
	);
	return parseTokenResponse(payload, credentials.profileArn);
}

async function registerClient(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<KiroClientRegistration> {
	const payload = await postKiroAuth(
		"RegisterClient",
		{
			clientName: KIRO_CLIENT_NAME,
			clientType: "public",
			grantTypes: [DEVICE_GRANT, REFRESH_GRANT],
		},
		fetchImpl,
		signal,
	);
	if (
		!isRecord(payload) ||
		typeof payload.clientId !== "string" ||
		typeof payload.clientSecret !== "string" ||
		typeof payload.clientSecretExpiresAt !== "number"
	) {
		throw new AIError.OAuthError("Kiro RegisterClient response is missing client credentials", {
			kind: "validation",
			provider: "kiro",
		});
	}
	return {
		clientId: payload.clientId,
		clientSecret: payload.clientSecret,
		expiresAt: payload.clientSecretExpiresAt * 1_000,
	};
}

async function startDeviceAuthorization(
	registration: KiroClientRegistration,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<KiroDeviceAuthorization> {
	const payload = await postKiroAuth(
		"StartDeviceAuthorization",
		{
			clientId: registration.clientId,
			clientSecret: registration.clientSecret,
			startUrl: KIRO_START_URL,
		},
		fetchImpl,
		signal,
	);
	if (
		!isRecord(payload) ||
		typeof payload.deviceCode !== "string" ||
		typeof payload.userCode !== "string" ||
		typeof payload.verificationUriComplete !== "string" ||
		typeof payload.expiresIn !== "number"
	) {
		throw new AIError.OAuthError("Kiro StartDeviceAuthorization response is invalid", {
			kind: "validation",
			provider: "kiro",
		});
	}
	return {
		deviceCode: payload.deviceCode,
		userCode: payload.userCode,
		verificationUriComplete: payload.verificationUriComplete,
		expiresInSeconds: payload.expiresIn,
		intervalSeconds: typeof payload.interval === "number" && payload.interval > 0 ? payload.interval : 5,
	};
}

async function pollKiroDeviceToken(
	registration: KiroClientRegistration,
	deviceCode: string,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<OAuthDeviceCodePollResult<OAuthCredentials>> {
	try {
		const payload = await postKiroAuth(
			"CreateToken",
			{
				clientId: registration.clientId,
				clientSecret: registration.clientSecret,
				grantType: DEVICE_GRANT,
				deviceCode,
			},
			fetchImpl,
			signal,
		);
		return { status: "complete", value: parseTokenResponse(payload) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("AuthorizationPending")) return { status: "pending" };
		if (message.includes("SlowDown")) return { status: "slow_down" };
		return { status: "failed", message };
	}
}

async function postKiroAuth(
	operation: string,
	body: Record<string, unknown>,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<unknown> {
	const response = await fetchImpl(KIRO_AUTH_URL, {
		method: "POST",
		headers: {
			"content-type": "application/x-amz-json-1.0",
			"x-amz-target": `${KIRO_AUTH_TARGET_PREFIX}${operation}`,
		},
		body: JSON.stringify(body),
		signal,
	});
	const payload = await response.json().catch(() => undefined);
	if (!response.ok) {
		const detail = isRecord(payload) && typeof payload.message === "string" ? payload.message : response.statusText;
		throw new AIError.OAuthError(`Kiro ${operation} failed: ${detail}`, {
			kind: "request",
			provider: "kiro",
		});
	}
	return payload;
}

function parseTokenResponse(payload: unknown, profileArn?: string): OAuthCredentials {
	if (
		!isRecord(payload) ||
		typeof payload.accessToken !== "string" ||
		typeof payload.refreshToken !== "string" ||
		typeof payload.expiresIn !== "number"
	) {
		throw new AIError.OAuthError("Kiro CreateToken response is missing token fields", {
			kind: "validation",
			provider: "kiro",
		});
	}
	return {
		access: payload.accessToken,
		refresh: payload.refreshToken,
		expires: Date.now() + payload.expiresIn * 1_000,
		profileArn: typeof payload.profileArn === "string" ? payload.profileArn : profileArn,
	};
}
