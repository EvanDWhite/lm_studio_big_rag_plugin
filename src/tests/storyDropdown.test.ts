import { test, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type PluginContext } from "@lmstudio/sdk";
import { getConfigSchematics, NO_STORY_VALUE } from "../config";
import { main } from "../index";
import { preprocess } from "../promptPreprocessor";
import { resetVectorStoreCacheForTest } from "../rag/retrieval";
import {
  getDropdownState,
  initStoryDropdown,
  readStoriesRootHint,
  resolveStartupStoriesRoot,
  writeStoriesRootHint,
} from "../stories/storyDropdown";
import { createStory, type StoryHandle } from "../stories/storyRegistry";
import { isolateHome, makeCtl, makeFakeClient, textOf, userMessage, writeFiles } from "./helpers/fakeLmStudio";

let base = "";
let storiesRoot = "";
let restoreHome: () => void = () => undefined;
let alpha: StoryHandle;
let beta: StoryHandle;

function storyOptions(): Array<{ value: string; displayName: string }> {
  const schematics = getConfigSchematics() as unknown as { getValueTypeParam: (key: string) => { options: Array<{ value: string; displayName: string }> } };
  return schematics.getValueTypeParam("story").options;
}

function statusTexts(statuses: Array<{ text: string }>): string {
  return statuses.map((s) => s.text).join("\n");
}

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "big-rag-dropdown-"));
  restoreHome = isolateHome(base);
  storiesRoot = path.join(base, "library");
  const alphaTitle = path.join(base, "titles", "The Salt Kingdom");
  const betaTitle = path.join(base, "titles", "Brass Nebula");
  writeFiles(alphaTitle, { "chapter_md/a.md": "vexmora alpha saga", "chapter_raw/a.txt": "RAWDUP vexmora saga" });
  writeFiles(betaTitle, { "chapter_md/b.md": "ilsanebula beta saga" });
  alpha = await createStory(storiesRoot, { titleDir: alphaTitle, embeddingModelId: "fake-embedder" });
  beta = await createStory(storiesRoot, { titleDir: betaTitle, embeddingModelId: "fake-embedder" });
});

beforeEach(async () => {
  await initStoryDropdown(storiesRoot);
});

after(async () => {
  await resetVectorStoreCacheForTest();
  restoreHome();
  fs.rmSync(base, { recursive: true, force: true });
});

test("dropdown lists None (default) plus every story, read at startup", () => {
  assert.deepEqual(storyOptions(), [
    { value: NO_STORY_VALUE, displayName: "None (RAG off)" },
    { value: "brass-nebula", displayName: "Brass Nebula (brass-nebula)" },
    { value: "the-salt-kingdom", displayName: "The Salt Kingdom (the-salt-kingdom)" },
  ]);
  const parsed = (getConfigSchematics() as unknown as { parse: (c: unknown) => { get: (k: string) => unknown } }).parse({ fields: [] });
  assert.equal(parsed.get("story"), NO_STORY_VALUE, "new chats default to None");
  assert.deepEqual(getDropdownState()?.storyIds, ["brass-nebula", "the-salt-kingdom"]);
});

test("main() registers the dropdown schematics built from $BIG_RAG_STORIES_ROOT", async () => {
  const registered: Record<string, unknown> = {};
  const context = {
    withConfigSchematics: (s: unknown) => ((registered.config = s), context),
    withGlobalConfigSchematics: (s: unknown) => ((registered.global = s), context),
    withPromptPreprocessor: () => context,
    withToolsProvider: () => context,
  } as unknown as PluginContext;
  process.env.BIG_RAG_STORIES_ROOT = storiesRoot;
  try {
    await main(context);
  } finally {
    delete process.env.BIG_RAG_STORIES_ROOT;
  }
  assert.equal(registered.config, getConfigSchematics(), "preprocess must read config with the registered instance");
  assert.ok(registered.global);
  assert.equal(storyOptions().length, 3);
});

test("startup root: env var > hint written by a chat > default", () => {
  assert.equal(resolveStartupStoriesRoot({ BIG_RAG_STORIES_ROOT: "/env/root" }), path.resolve("/env/root"));
  writeStoriesRootHint("/hinted/root");
  assert.equal(readStoriesRootHint(), "/hinted/root");
  assert.equal(resolveStartupStoriesRoot({}), path.resolve("/hinted/root"));
  fs.rmSync(path.join(os.homedir(), ".lmstudio", "big-rag-stories-root-hint.json"));
  assert.equal(resolveStartupStoriesRoot({}), path.join(os.homedir(), ".lmstudio", "big-rag-stories"));
});

test("selecting a story in the dropdown searches only that story, with a status line naming it", async () => {
  const chat = makeCtl({ story: alpha.id }, makeFakeClient(), { storiesRoot });
  const prompt = textOf(await preprocess(chat.ctl, userMessage("vexmora saga")));
  assert.ok(prompt.includes("Citation") && prompt.includes("vexmora") && !prompt.includes("ilsanebula"));
  assert.ok(!prompt.includes("RAWDUP"));
  assert.ok(statusTexts(chat.statuses).includes("📚 Story: The Salt Kingdom (the-salt-kingdom) · via dropdown"));
  assert.ok(statusTexts(chat.statuses).includes("from The Salt Kingdom"));
  assert.equal(readStoriesRootHint(), storiesRoot, "chat records the root it used for the next startup");
});

test("typed Story ID override wins over the dropdown", async () => {
  const chat = makeCtl({ story: alpha.id, storyId: beta.id }, makeFakeClient(), { storiesRoot });
  const prompt = textOf(await preprocess(chat.ctl, userMessage("saga")));
  assert.ok(prompt.includes("ilsanebula") && !prompt.includes("vexmora"));
  assert.ok(statusTexts(chat.statuses).includes("📚 Story: Brass Nebula (brass-nebula) · via typed Story ID override"));
});

test("a story created after startup is usable via the typed override and flagged as not in the dropdown", async () => {
  const lateTitle = path.join(base, "titles", "Late Arrival");
  writeFiles(lateTitle, { "chapter_md/l.md": "latecomer gamma saga" });
  const late = await createStory(storiesRoot, { titleDir: lateTitle, embeddingModelId: "fake-embedder" });
  const chat = makeCtl({ storyId: late.id }, makeFakeClient(), { storiesRoot });
  const prompt = textOf(await preprocess(chat.ctl, userMessage("latecomer saga")));
  assert.ok(prompt.includes("latecomer"));
  assert.ok(statusTexts(chat.statuses).includes("not in the dropdown yet (reload the plugin to list it)"));
});

test("dropdown None and no override: RAG off, status says so, message unchanged", async () => {
  const client = makeFakeClient();
  const chat = makeCtl({ story: NO_STORY_VALUE }, client, { storiesRoot });
  const message = userMessage("vexmora");
  assert.equal(await preprocess(chat.ctl, message), message);
  assert.equal(client.calls.embeds, 0);
  assert.ok(statusTexts(chat.statuses).includes("📚 Big RAG is off for this chat: no story selected. No search was run."));
});

test("a saved dropdown value that is no longer listed fails closed instead of crashing", async () => {
  const client = makeFakeClient();
  const chat = makeCtl({ story: "deleted-story" }, client, { storiesRoot });
  const message = userMessage("vexmora");
  assert.equal(await preprocess(chat.ctl, message), message);
  assert.equal(client.calls.embeds, 0);
  assert.ok(chat.statuses.some((s) => s.status === "error" && s.text.includes("no longer in the dropdown")));
});

test("a listed story whose folder was removed since startup fails closed", async () => {
  const goneTitle = path.join(base, "titles", "Gone Soon");
  fs.mkdirSync(goneTitle, { recursive: true });
  const gone = await createStory(storiesRoot, { titleDir: goneTitle });
  await initStoryDropdown(storiesRoot);
  fs.rmSync(gone.rootDir, { recursive: true, force: true });
  const client = makeFakeClient();
  const chat = makeCtl({ story: gone.id }, client, { storiesRoot });
  const message = userMessage("x");
  assert.equal(await preprocess(chat.ctl, message), message);
  assert.ok(chat.statuses.some((s) => s.status === "error" && s.text.includes('Story "gone-soon" not found')));
});

test("status line warns when the dropdown was listed from a different Stories Root", async () => {
  await initStoryDropdown(path.join(base, "some-other-root"));
  const chat = makeCtl({ storyId: alpha.id }, makeFakeClient(), { storiesRoot });
  await preprocess(chat.ctl, userMessage("vexmora"));
  assert.ok(statusTexts(chat.statuses).includes("reload the plugin to refresh it"));
});
