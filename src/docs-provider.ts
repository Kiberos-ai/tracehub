import { createDocsProvider, type RawPage } from "@context777/provider";
import { DOC_PAGES } from "./routes/docs";
import {
	DOCS_CENTRAL_URL,
	DOCS_SOURCE_SECRET,
	DOCS_PROVIDER_URL,
	DOCS_PUBLIC_BASE,
} from "./lib/config";

// =============================================================================
// TracHub docs provider — exposes TracHub's own documentation through the
// @context777/provider contract (mounted at /help/api) so context777 can ingest
// it into the central documentation index. First adopter of the provider model.
// =============================================================================

function titleFromMarkdown(slug: string, markdown: string): string {
	const m = markdown.match(/^#\s+(.+)/m);
	return m ? m[1].trim() : slug;
}

/** Build the page set from the in-code DOC_PAGES map. */
function getPages(): RawPage[] {
	return Object.entries(DOC_PAGES).map(([key, markdown]) => {
		const slug = key.replace(/\.md$/, "");
		return {
			slug,
			title: titleFromMarkdown(slug, markdown),
			url: `${DOCS_PUBLIC_BASE}/${key}`,
			markdown,
		};
	});
}

export const docsProvider = createDocsProvider({
	library: "tracehub",
	version: "1.0.0",
	getPages,
	central: DOCS_CENTRAL_URL
		? {
				url: DOCS_CENTRAL_URL,
				secret: DOCS_SOURCE_SECRET,
				providerUrl: DOCS_PROVIDER_URL,
			}
		: undefined,
});
