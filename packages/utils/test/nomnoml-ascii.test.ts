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
});
