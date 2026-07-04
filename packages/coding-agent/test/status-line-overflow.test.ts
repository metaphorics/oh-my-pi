import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getSessionAccentAnsi, getSessionAccentHex } from "@oh-my-pi/pi-coding-agent/utils/session-color";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

/** Minimal SegmentContext factory — only path/git fields matter for these tests. */
function createCtx(overrides?: { pathMaxLength?: number; branch?: string | null }): SegmentContext {
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: undefined,
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {
			path: {
				abbreviate: false,
				maxLength: overrides?.pathMaxLength ?? 40,
				stripWorkPrefix: false,
			},
		},
		planMode: null,
		loopMode: null,
		goalMode: null,
		collab: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		activeMs: 0,
		activeRepo: null,
		worktree: null,
		git: {
			branch: overrides?.branch ?? null,
			status: null,
			pr: null,
		},
		usage: null,
	};
}

function createStatusLineSession(sessionName: string) {
	return {
		state: { messages: [] },
		isStreaming: false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getCurrentModel: () => undefined,
		isFastModeEnabled: () => false,
		sessionManager: {
			getSessionName: () => sessionName,
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

describe("status line session accent", () => {
	function buildComponent(sessionAccent: boolean) {
		const component = new StatusLineComponent(createStatusLineSession("Named session"));
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: ["session_name"],
			separator: "powerline-thin",
			sessionAccent,
		});
		return component;
	}

	// Computed lazily: `theme` is assigned by initTheme() in beforeAll, after module evaluation.
	const accentAnsi = () =>
		getSessionAccentAnsi(
			getSessionAccentHex("Named session", theme.getMajorThemeColorHexes(), theme.accentSurfaceLuminance),
		);

	it("paints the gap with the session accent when enabled", () => {
		const ansi = accentAnsi();
		expect(ansi).toBeDefined();
		const border = buildComponent(true).getTopBorder(80).content;
		expect(border).toContain(`${ansi}${theme.boxRound.horizontal}`);
	});

	it("paints the gap with the border color and omits the session accent when disabled", () => {
		const ansi = accentAnsi();
		expect(ansi).toBeDefined();
		const border = buildComponent(false).getTopBorder(80).content;
		// Positive: gap is rendered with the theme border color.
		expect(border).toContain(`${theme.getFgAnsi("border")}${theme.boxRound.horizontal}`);
		// Negative: the gap-painting pattern (accent ANSI directly followed by a horizontal
		// glyph) must not appear. The session_name segment may still emit the accent ANSI
		// for its own text — we only care that the gap is not accent-painted.
		expect(border).not.toContain(`${ansi}${theme.boxRound.horizontal}`);
	});
});

describe("path segment truncation at varying maxLength", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-overflow-very-long-directory-name-for-testing-"));
		setProjectDir(tmpDir);
	});

	it("truncates path with ellipsis when maxLength is smaller than path", () => {
		const full = renderSegment("path", createCtx({ pathMaxLength: 200 }));
		const short = renderSegment("path", createCtx({ pathMaxLength: 10 }));

		expect(full.visible).toBe(true);
		expect(short.visible).toBe(true);
		expect(visibleWidth(short.content)).toBeLessThan(visibleWidth(full.content));
	});

	it("reduces visible width monotonically as maxLength decreases", () => {
		const widths = [40, 20, 10, 4].map(maxLen => {
			const rendered = renderSegment("path", createCtx({ pathMaxLength: maxLen }));
			return visibleWidth(rendered.content);
		});

		for (let i = 1; i < widths.length; i++) {
			expect(widths[i]).toBeLessThanOrEqual(widths[i - 1]);
		}
	});

	it("still renders a visible segment at maxLength=4", () => {
		const rendered = renderSegment("path", createCtx({ pathMaxLength: 4 }));
		expect(rendered.visible).toBe(true);
		expect(visibleWidth(rendered.content)).toBeGreaterThan(0);
	});
});
