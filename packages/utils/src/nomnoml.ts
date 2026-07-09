import nomnoml from "nomnoml";

import { renderNomnomlAsciiSafe } from "./nomnoml-ascii";

type NomnomlRuntime = typeof nomnoml & {
	renderSvg: (source: string) => string;
};

// nomnoml 1.7.0's .d.ts omits runtime exports used by the package itself.
const nomnomlRuntime = nomnoml as NomnomlRuntime;

export { renderNomnomlAsciiSafe };

export function renderNomnomlSvg(source: string): string | null {
	try {
		const normalizedSource = source.replace(/\r\n?/g, "\n").trim();
		if (!normalizedSource) return null;
		return nomnomlRuntime.renderSvg(normalizedSource);
	} catch {
		return null;
	}
}
