import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { LOG_PREFIX, PLUGIN_ID, PLUGIN_NAME, PLUGIN_OWNER, TOOL_INDEX_STATUS, TOOL_SEARCH } from "../identity";
import { STORIES_ROOT_HINT_FILENAME } from "../stories/storyDropdown";
import { defaultStoriesRoot } from "../stories/storyRegistry";

/** This fork must install as a separate LM Studio plugin from upstream mindstudio/big-rag. */
const repoRoot = path.resolve(__dirname, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifest.json"), "utf-8"));
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));

test("manifest owner/name are this fork's, valid per the LM Studio manifest schema, and match identity.ts", () => {
  assert.equal(manifest.type, "plugin");
  assert.equal(manifest.owner, PLUGIN_OWNER);
  assert.equal(manifest.name, PLUGIN_NAME);
  assert.match(manifest.owner, /^[a-z0-9]+(?:-[a-z0-9]+)*$/); // SDK kebabCaseSchema
  assert.match(manifest.name, /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/); // SDK kebabCaseWithDotsSchema
  assert.notEqual(PLUGIN_ID, "mindstudio/big-rag");
  assert.equal(pkg.name, `lms-plugin-${PLUGIN_NAME}`);
});

test("tool names, log prefix and data paths do not collide with upstream Big RAG", () => {
  assert.ok(![TOOL_SEARCH, TOOL_INDEX_STATUS].some((t) => t === "big_rag_search" || t === "big_rag_index_status"));
  assert.notEqual(LOG_PREFIX, "[BigRAG]");
  assert.equal(path.basename(defaultStoriesRoot()), PLUGIN_NAME);
  assert.ok(STORIES_ROOT_HINT_FILENAME.startsWith(PLUGIN_NAME));
});
