export const MCP_CONNECTING_EVENT_CHANNEL = "mcp:connecting";

export type McpConnectingEvent = { serverNames: string[] };

export function formatMCPConnectingMessage(serverNames: string[]): string {
	return `Connecting to MCP servers: ${serverNames.join(", ")}…`;
}
