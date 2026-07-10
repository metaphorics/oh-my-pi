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

	it("places grapheme clusters without overwriting the closing border", () => {
		for (const label of ["e\u0301", "👩‍💻"]) {
			const rendered = stripDiagram(renderNomnomlAsciiSafe(`[${label}]`, 80));
			const rows = rendered.split("\n");

			expect(rendered).toContain(`│${label}│`);
			expect(new Set(rows.map(row => Bun.stringWidth(row))).size).toBe(1);
		}
	});

	for (const [style, source] of [
		["built-in", "[A] -/- [<hidden> secret] -/- [B]"],
		["custom", "#.ghost: visual=hidden\n[A] -/- [<ghost> secret] -/- [B]"],
	] as const) {
		it(`omits ${style} hidden node visuals while retaining their layout gap`, () => {
			const direct = stripDiagram(renderNomnomlAsciiSafe("[A] -/- [B]", 80));
			const directRows = direct.split("\n");
			const directGap =
				directRows.findIndex(row => row.includes("B")) - directRows.findIndex(row => row.includes("A"));
			const rendered = stripDiagram(renderNomnomlAsciiSafe(source, 80));
			const rows = rendered.split("\n");
			const hiddenGap = rows.findIndex(row => row.includes("B")) - rows.findIndex(row => row.includes("A"));

			expect(rendered).not.toContain("secret");
			expect(rendered.match(/┌/g)).toHaveLength(2);
			expect(hiddenGap).toBeGreaterThan(directGap);
		});
	}
	for (const [style, source, expectedLines, expectedWidth] of [
		["built-in", "[<package> Pkg|\n  [A]\n  [B]\n  [<hidden> secret]\n]", 24, 9],
		["custom", "#.ghost: visual=hidden\n[<package> Pkg|\n  [A]\n  [B]\n  [<ghost> secret]\n]", 24, 9],
	] as const) {
		it(`hides nested ${style} package child while preserving the computed container layout`, () => {
			const rendered = stripDiagram(renderNomnomlAsciiSafe(source, 80));
			const rows = rendered.split("\n");
			const widths = rows.map(line => Bun.stringWidth(line));

			expect(rendered).not.toContain("secret");
			expect(rendered).toContain("Pkg");
			expect(rendered).toContain("A");
			expect(rendered).toContain("B");
			expect(rendered).toMatch(/│\s*─{2,}\s*│/);
			expect(rows.length).toBe(expectedLines);
			expect(new Set(widths).size).toBe(1);
			expect(widths[0]).toBe(expectedWidth);
		});
	}

	it("places direct association markers on connector-facing edge points", () => {
		// nomnoml path for [A]->[B] is [source center, top edge, mid, bottom edge, target center].
		// Marker must land on path[length-2] (x=2,y=7,v), not node-center (2,9) or mid-route (2,5).
		const endRows = stripDiagram(renderNomnomlAsciiSafe("[A] -> [B]", 80)).split("\n");
		expect(endRows[7]?.[2]).toBe("v");
		expect(endRows[9]?.[2]).not.toBe("v");
		expect(endRows[5]?.[2]).not.toBe("v");

		// Reverse arrow uses path[1] with direction toward the source center.
		const startRows = stripDiagram(renderNomnomlAsciiSafe("[A] <- [B]", 80)).split("\n");
		expect(startRows[3]?.[2]).toBe("^");
		expect(startRows[1]?.[2]).not.toBe("^");

		const bothRows = stripDiagram(renderNomnomlAsciiSafe("[A] <-> [B]", 80)).split("\n");
		expect(bothRows[3]?.[2]).toBe("^");
		expect(bothRows[7]?.[2]).toBe("v");
	});

	it("places bent multi-point association markers on the final connector edge points", () => {
		// Three associations: two short routes (5 pts) plus a deliberate bend Start->End (7 pts).
		// End markers sit at path[length-2]: Mid top (3,7,v), End left (4,14,v), End right (7,14,v).
		// Node-center placement would put End markers on (6,16); wrong penultimate uses (9,12).
		const source = "[Start] -> [Mid]\n[Mid] -> [End]\n[Start] -> [End]";
		const rows = stripDiagram(renderNomnomlAsciiSafe(source, 80)).split("\n");

		expect(rows[7]?.[3]).toBe("v");
		expect(rows[14]?.[4]).toBe("v");
		expect(rows[14]?.[7]).toBe("v");

		// Node-center placement for the bent Start->End edge.
		expect(rows[16]?.[6]).not.toBe("v");
		// Wrong penultimate (path[length-3]) for the bent route.
		expect(rows[12]?.[9]).not.toBe("v");

		const markerCells = rows.flatMap((row, y) =>
			[...row].flatMap((ch, x) => ("<>^v".includes(ch) ? [{ x, y, ch }] : [])),
		);
		expect(markerCells).toEqual([
			{ x: 3, y: 7, ch: "v" },
			{ x: 4, y: 14, ch: "v" },
			{ x: 7, y: 14, ch: "v" },
		]);
	});

	for (const [source, decorator] of [
		["[A] +-> [B]", "♦"],
		["[A] o-> [B]", "◇"],
		["[A] <:- [B]", "△"],
	] as const) {
		it(`renders the ${decorator} endpoint decorator on a direct connector`, () => {
			const rendered = stripDiagram(renderNomnomlAsciiSafe(source, 80));
			expect(rendered).toContain(decorator);
			expect(rendered).toContain("A");
			expect(rendered).toContain("B");
		});
	}

	it("retains distinct endpoint decorators on bent connectors", () => {
		const rendered = stripDiagram(renderNomnomlAsciiSafe("[Start] +-> [Mid]\n[Mid] -> [End]\n[Start] o-> [End]", 80));
		expect(rendered).toContain("♦");
		expect(rendered).toContain("◇");
		expect(rendered.match(/[>v<^]/g)?.length).toBeGreaterThanOrEqual(3);
	});

	it("renders supported socket decorators without exposing their literal source", () => {
		for (const [source, decorator] of [
			["[A] (- [B]", "⌢"],
			["[A] (o- [B]", "⊙"],
			["[A] o<- [B]", "⊚"],
		] as const) {
			const rendered = stripDiagram(renderNomnomlAsciiSafe(source, 80));
			expect(rendered).toContain(decorator);
			expect(rendered).not.toContain(source);
		}
	});

	it("does not leak hidden classifier source while rendering its visible connector decorator", () => {
		const source = "[<hidden> secret] +-> [Visible]";
		const rendered = stripDiagram(renderNomnomlAsciiSafe(source, 80));
		expect(rendered).toContain("♦");
		expect(rendered).toContain("Visible");
		expect(rendered).not.toContain("secret");
		expect(rendered).not.toContain("hidden");
		expect(rendered).not.toContain(source);
	});

	for (const [description, source] of [
		["later wider compartment", "[User|veryLongFieldName]"],
		["earlier wider compartment", "[veryLongClassName|x]"],
		["nested later content", "[Outer|[Inner|veryLongNestedField]]"],
	] as const) {
		it(`spans the final interior width for ${description}`, () => {
			const rows = stripDiagram(renderNomnomlAsciiSafe(source, 80)).split("\n");
			const topBorder = rows.find(row => /^┌─+┐$/.test(row));
			const divider = rows.find(row => /^│─+│$/.test(row));
			expect(topBorder).toBeDefined();
			expect(divider).toBeDefined();
			expect(Bun.stringWidth(divider ?? "")).toBe(Bun.stringWidth(topBorder ?? ""));
		});
	}
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

	for (const [style, source] of [
		["built-in", "[<hidden> secret]"],
		["custom", "#.ghost: visual=hidden\n[<ghost> secret]"],
	] as const) {
		it(`returns empty string for all-hidden ${style} diagrams without falling back to null`, () => {
			const rendered = renderNomnomlAsciiSafe(source, 80);
			// Empty string = successful blank layout; null would make Markdown leak source.
			expect(rendered).toBe("");
			expect(rendered).not.toBeNull();
			expect(String(rendered)).not.toContain("secret");
			expect(String(rendered)).not.toContain("hidden");
			expect(String(rendered)).not.toContain("```");
		});
	}
});
