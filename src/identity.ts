/**
 * Plugin identity. This fork is a SEPARATE LM Studio plugin from upstream `mindstudio/big-rag`
 * (manifest.json owner/name = evandwhite/big-rag-stories), so both can be installed side by side.
 * Keep these in sync with manifest.json and package.json.
 */
export const PLUGIN_OWNER = "evandwhite";
export const PLUGIN_NAME = "big-rag-stories";
export const PLUGIN_ID = `${PLUGIN_OWNER}/${PLUGIN_NAME}`;
export const PLUGIN_DISPLAY_NAME = "Big RAG Stories";

/** Prefix for console logs, so this plugin's lines are distinguishable from upstream Big RAG's. */
export const LOG_PREFIX = "[BigRAG-Stories]";

/** Tool names differ from upstream's big_rag_search / big_rag_index_status (no clash if both are enabled). */
export const TOOL_SEARCH = "big_rag_stories_search";
export const TOOL_INDEX_STATUS = "big_rag_stories_index_status";
