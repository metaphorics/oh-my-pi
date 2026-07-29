import type { ModelSpec } from "../types";

/** Kiro has no model-id-derived compatibility switches. */
export function buildKiroCompat(_spec: ModelSpec<"kiro-agent">): undefined {
	return undefined;
}
