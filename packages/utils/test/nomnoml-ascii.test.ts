import { describe, expect, it } from "bun:test";
import { renderNomnomlAsciiSafe } from "../src/nomnoml";

function stripDiagram(ascii: string | null): string {
	return ascii ?? "";
}

describe("renderNomnomlAsciiSafe", () => {
	it("renders labeled boxes and a directed connector", () => {
		const rendered = stripDiagram(renderNomnomlAsciiSafe("#direction: right\n[A] -> [B]", 80));

		expect(rendered).toContain("A");
		expect(rendered).toContain("B");
		expect(rendered).toContain("┌");
		expect(/[>v<^]/.test(rendered)).toBe(true);
	});

	it("returns null for invalid nomnoml", () => {
		expect(renderNomnomlAsciiSafe("[A", 80)).toBeNull();
	});

	it("returns null when the diagram cannot fit after direction retry", () => {
		const source = "[This label is much wider than the viewport] -> [B]";

		expect(renderNomnomlAsciiSafe(source, 8)).toBeNull();
	});

	it("returns null instead of clipping layouts past the canvas dimension limit", () => {
		const source = `[${"A".repeat(450)}]`;

		expect(renderNomnomlAsciiSafe(source, 1000)).toBeNull();
	});

	it("keeps rows aligned when labels contain wide glyphs", () => {
		const rendered = stripDiagram(renderNomnomlAsciiSafe("[漢字😀]", 80));
		const widths = rendered.split("\n").map(line => Bun.stringWidth(line));
		expect(rendered).toContain("漢字😀");
		expect(new Set(widths).size).toBe(1);
	});

	it("does not draw layout-only hidden association connectors", () => {
		const rendered = stripDiagram(renderNomnomlAsciiSafe("#direction: right\n[A] -/- [B]", 80));
		expect(rendered).toContain("A");
		expect(rendered).toContain("B");
		// This layout stacks A above B. The hidden edge must leave the inter-box
		// gap blank (no vertical │/horizontal ─/arrowhead); unguarded ASCII path
		// previously painted a vertical connector there.
		const lines = rendered.split("\n");
		const firstBottom = lines.findIndex(line => line.includes("└"));
		const secondTop = lines.findIndex((line, index) => index > firstBottom && line.includes("┌"));
		expect(firstBottom).toBeGreaterThanOrEqual(0);
		expect(secondTop).toBeGreaterThan(firstBottom);
		const gap = lines.slice(firstBottom + 1, secondTop);
		expect(gap.length).toBeGreaterThan(0);
		expect(gap.every(line => line.trim() === "")).toBe(true);
	});
});
