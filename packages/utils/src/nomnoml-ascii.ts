import nomnoml from "nomnoml";

type Point = { x: number; y: number };
type Label = { text?: string; x?: number; y?: number; width?: number; height?: number };
type LayoutPart = {
	lines?: string[];
	nodes?: LayoutNode[];
	assocs?: Association[];
	width?: number;
	height?: number;
	x?: number;
	y?: number;
};
type LayoutNode = LayoutPart & {
	id?: string;
	type?: string;
	parts?: LayoutPart[];
	dividers?: number[];
};
type Association = {
	type?: string;
	path?: Point[];
	points?: Point[];
	startLabel?: Label;
	endLabel?: Label;
};
type NomnomlConfig = {
	direction?: string;
	padding?: number;
	spacing?: number;
	gutter?: number;
	edgeMargin?: number;
	arrowSize?: number;
	bendSize?: number;
	styles?: Record<string, { visual?: string }>;
};
type ParsedNomnoml = { root: LayoutPart; config: NomnomlConfig };
type Measurer = {
	setFont: (font: string, size: number, weight: string, style: string) => void;
	textWidth: (text: string) => number;
	textHeight: () => number;
};
type NomnomlRuntime = typeof nomnoml & {
	parse: (source: string) => ParsedNomnoml;
	layout: (measurer: Measurer, config: NomnomlConfig, root: LayoutPart) => void;
};

// nomnoml 1.7.0 ships incomplete .d.ts declarations: parse/layout are exported
// at runtime but absent from the type file. Keep the escape hatch local.
const nomnomlRuntime = nomnoml as NomnomlRuntime;

const MAX_CANVAS_CELLS = 40_000;
const MAX_DIMENSION = 400;
const WIDE_CONTINUATION_CELL = "\0";
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

class CharGrid {
	#cells: string[][];

	constructor(
		readonly width: number,
		readonly height: number,
	) {
		this.#cells = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
	}

	set(x: number, y: number, char: string): void {
		if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
		const row = this.#cells[y];
		if (!row) return;
		const previous = row[x];
		const current = previous === WIDE_CONTINUATION_CELL ? " " : (previous ?? " ");
		const next = mergeChars(current, char);
		row[x] = next;
		const width = Bun.stringWidth(next);
		// If a narrower glyph replaced a wider one at this leading cell, clear the
		// now-orphaned continuation sentinels it used to own.
		const previousWidth = previous && previous !== WIDE_CONTINUATION_CELL ? Bun.stringWidth(previous) : 1;
		for (let dx = Math.max(1, width); dx < previousWidth && x + dx < this.width; dx++) {
			if (row[x + dx] === WIDE_CONTINUATION_CELL) row[x + dx] = " ";
		}
		if (width <= 1) return;
		for (let dx = 1; dx < width && x + dx < this.width; dx++) {
			row[x + dx] = WIDE_CONTINUATION_CELL;
		}
	}

	text(x: number, y: number, text: string): void {
		let cursor = x;
		for (const { segment } of graphemeSegmenter.segment(text)) {
			this.set(cursor, y, segment);
			cursor += Bun.stringWidth(segment) || 1;
		}
	}

	lines(): string[] {
		let top = 0;
		let bottom = this.#cells.length - 1;
		while (top <= bottom && rowEmpty(this.#cells[top])) top++;
		while (bottom >= top && rowEmpty(this.#cells[bottom])) bottom--;
		if (top > bottom) return [];

		let left = this.width;
		let right = 0;
		for (let y = top; y <= bottom; y++) {
			const row = this.#cells[y];
			if (!row) continue;
			for (let x = 0; x < row.length; x++) {
				const cell = row[x] ?? " ";
				if (cell !== " " && cell !== WIDE_CONTINUATION_CELL) {
					left = Math.min(left, x);
					right = Math.max(right, x);
				}
			}
		}
		if (left > right) return [];

		const result: string[] = [];
		for (let y = top; y <= bottom; y++) {
			const row = this.#cells[y];
			if (!row) continue;
			result.push(
				row
					.slice(left, right + 1)
					.filter(cell => cell !== WIDE_CONTINUATION_CELL)
					.join("")
					.trimEnd(),
			);
		}
		return result;
	}
}

function rowEmpty(row: string[] | undefined): boolean {
	return row === undefined || row.every(char => char === " " || char === WIDE_CONTINUATION_CELL);
}

function isHorizontal(char: string): boolean {
	return char === "─" || char === "-" || char === "┼" || char === "+";
}

function isVertical(char: string): boolean {
	return char === "│" || char === "|" || char === "┼" || char === "+";
}

function mergeChars(current: string, next: string): string {
	if (current === " " || current === next) return next;
	if (next === " ") return current;
	if ((isHorizontal(current) && isVertical(next)) || (isVertical(current) && isHorizontal(next))) return "┼";
	if (current === "┼" && (isHorizontal(next) || isVertical(next))) return current;
	if (next === "┼" && (isHorizontal(current) || isVertical(current))) return next;
	if ("<>^v".includes(next)) return next;
	if ("┌┐└┘│─".includes(current) && "│─".includes(next)) return current;
	return next;
}

function compactConfig(config: NomnomlConfig, direction?: "TB" | "LR"): NomnomlConfig {
	return {
		...config,
		direction: direction ?? config.direction,
		padding: 1,
		spacing: 4,
		gutter: 2,
		edgeMargin: 0,
		arrowSize: 1,
		bendSize: 0.3,
	};
}

function layout(source: string, direction?: "TB" | "LR"): ParsedNomnoml | null {
	const parsed = nomnomlRuntime.parse(source);
	parsed.config = compactConfig(parsed.config, direction);
	const measurer: Measurer = {
		setFont: () => {},
		textWidth: (text: string) => Math.max(1, Bun.stringWidth(text)),
		textHeight: () => 1,
	};
	nomnomlRuntime.layout(measurer, parsed.config, parsed.root);
	return parsed;
}

function isHidden(node: LayoutNode, config: NomnomlConfig): boolean {
	return config.styles?.[node.type ?? "class"]?.visual === "hidden";
}

function collectNodeRows(node: LayoutNode, config: NomnomlConfig, depth = 0): string[] {
	const rows: string[] = [];
	const parts = node.parts ?? [];
	for (const part of parts) {
		for (const line of part.lines ?? []) rows.push(line);
		const children = part.nodes ?? [];
		if (children.length > 0) {
			for (const child of children) {
				if (!isHidden(child, config)) rows.push(...collectNodeRows(child, config, depth + 1));
			}
		}
		if (depth === 0 && rows.length > 0 && part !== parts[parts.length - 1])
			rows.push("─".repeat(Math.max(1, nodeWidth(rows))));
	}
	if (rows.length === 0 && node.id) rows.push(node.id);
	return rows.map(row => row.trim()).filter(row => row.length > 0);
}

function nodeWidth(rows: string[]): number {
	let width = 1;
	for (const row of rows) width = Math.max(width, Bun.stringWidth(row));
	return width;
}

function drawNode(grid: CharGrid, node: LayoutNode, config: NomnomlConfig): void {
	const rows = collectNodeRows(node, config);
	const contentWidth = nodeWidth(rows);
	const width = Math.max(3, Math.ceil(node.width ?? contentWidth + 2));
	const height = Math.max(3, Math.ceil(node.height ?? rows.length + 2));
	const left = Math.round((node.x ?? 0) - width / 2);
	const top = Math.round((node.y ?? 0) - height / 2);
	const right = left + width - 1;
	const bottom = top + height - 1;

	grid.set(left, top, "┌");
	grid.set(right, top, "┐");
	grid.set(left, bottom, "└");
	grid.set(right, bottom, "┘");
	for (let x = left + 1; x < right; x++) {
		grid.set(x, top, "─");
		grid.set(x, bottom, "─");
	}
	for (let y = top + 1; y < bottom; y++) {
		grid.set(left, y, "│");
		grid.set(right, y, "│");
	}

	const availableRows = Math.max(1, height - 2);
	for (let i = 0; i < Math.min(rows.length, availableRows); i++) {
		const row = rows[i] ?? "";
		const rowWidth = Bun.stringWidth(row);
		const x = left + 1 + Math.max(0, Math.floor((width - 2 - rowWidth) / 2));
		grid.text(x, top + 1 + i, row);
	}
}

function drawAssociationLines(grid: CharGrid, assoc: Association): void {
	if (assoc.type === "-/-") return;
	const points = assoc.path ?? assoc.points ?? [];
	if (points.length < 2) return;
	for (let i = 1; i < points.length; i++) {
		const previous = points[i - 1];
		const current = points[i];
		if (!previous || !current) continue;
		drawSegment(grid, roundPoint(previous), roundPoint(current));
	}
}

function drawAssociationDecorations(grid: CharGrid, assoc: Association): void {
	if (assoc.type === "-/-") return;
	const points = assoc.path ?? assoc.points ?? [];
	if (points.length < 2) return;
	const type = assoc.type ?? "";
	if (type.includes(">")) drawArrow(grid, points, false);
	if (type.includes("<")) drawArrow(grid, points, true);
	drawLabel(grid, assoc.startLabel);
	drawLabel(grid, assoc.endLabel);
}

function roundPoint(point: Point): Point {
	return { x: Math.round(point.x), y: Math.round(point.y) };
}

function drawSegment(grid: CharGrid, start: Point, end: Point): void {
	if (start.x !== end.x && start.y !== end.y) {
		drawSegment(grid, start, { x: end.x, y: start.y });
		drawSegment(grid, { x: end.x, y: start.y }, end);
		return;
	}
	if (start.x === end.x) {
		const min = Math.min(start.y, end.y);
		const max = Math.max(start.y, end.y);
		for (let y = min; y <= max; y++) grid.set(start.x, y, "│");
		return;
	}
	const min = Math.min(start.x, end.x);
	const max = Math.max(start.x, end.x);
	for (let x = min; x <= max; x++) grid.set(x, start.y, "─");
}

function drawArrow(grid: CharGrid, points: Point[], atStart: boolean): void {
	// path = [sourceNode, ...edge.points, targetNode]; marker at path[1]/path[length-2]
	const arrowPoint = atStart ? points[1] : points[points.length - 2];
	const towardPoint = atStart ? points[0] : points[points.length - 1];
	if (!arrowPoint || !towardPoint) return;
	const dx = towardPoint.x - arrowPoint.x;
	const dy = towardPoint.y - arrowPoint.y;
	const char = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? ">" : "<") : dy >= 0 ? "v" : "^";
	const point = roundPoint(arrowPoint);
	grid.set(point.x, point.y, char);
}

function drawLabel(grid: CharGrid, label: Label | undefined): void {
	const text = label?.text?.trim();
	if (!text || label?.x === undefined || label.y === undefined) return;
	const x = Math.round(label.x - Bun.stringWidth(text) / 2);
	const y = Math.round(label.y);
	grid.text(x, y, text);
}

function asciiDisplayWidth(ascii: string): number {
	let max = 0;
	for (const line of ascii.split("\n")) max = Math.max(max, Bun.stringWidth(line));
	return max;
}

function renderLayout(root: LayoutPart, config: NomnomlConfig): string | null {
	const width = Math.max(1, Math.ceil(root.width ?? 0) + 2);
	const height = Math.max(1, Math.ceil(root.height ?? 0) + 2);
	if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_CANVAS_CELLS) return null;
	const grid = new CharGrid(width, height);
	for (const assoc of root.assocs ?? []) drawAssociationLines(grid, assoc);
	for (const node of root.nodes ?? []) {
		if (!isHidden(node, config)) drawNode(grid, node, config);
	}
	for (const assoc of root.assocs ?? []) drawAssociationDecorations(grid, assoc);
	const lines = grid.lines();
	// Empty string = valid layout with nothing visible (e.g. all-hidden nodes).
	// null is reserved for parse/layout/oversized failure so Markdown can fall back.
	return lines.join("\n");
}

function renderVariant(source: string, direction?: "TB" | "LR"): string | null {
	const parsed = layout(source, direction);
	return parsed ? renderLayout(parsed.root, parsed.config) : null;
}

export function renderNomnomlAsciiSafe(source: string, maxWidth = 120): string | null {
	try {
		const normalizedSource = source.replace(/\r\n?/g, "\n").trim();
		if (!normalizedSource) return null;
		const base = renderVariant(normalizedSource);
		let best: string | null = base !== null && asciiDisplayWidth(base) <= maxWidth ? base : null;
		let bestWidth = best === null ? Number.POSITIVE_INFINITY : asciiDisplayWidth(best);
		for (const direction of ["TB", "LR"] as const) {
			const variant = renderVariant(normalizedSource, direction);
			if (variant === null) continue;
			const width = asciiDisplayWidth(variant);
			if (width <= maxWidth && width < bestWidth) {
				best = variant;
				bestWidth = width;
			}
		}
		return best;
	} catch {
		return null;
	}
}
