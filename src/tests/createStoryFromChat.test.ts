import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preprocess } from "../promptPreprocessor";
import { resetVectorStoreCacheForTest } from "../rag/retrieval";
import { handleCreateStoryFromChat } from "../stories/createFromChat";
import { initStoryDropdown } from "../stories/storyDropdown";
import { createStory, loadStory } from "../stories/storyRegistry";
import { VectorStore } from "../vectorstore/vectorStore";
import { isolateHome, makeCtl, makeFakeClient, textOf, userMessage, writeFiles } from "./helpers/fakeLmStudio";

let base = "";
let storiesRoot = "";
let restoreHome: () => void = () => undefined;

const reader = (values: Record<string, unknown>) => ({ get: (k: string) => values[k] });

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "big-rag-create-"));
  restoreHome = isolateHome(base);
  storiesRoot = path.join(base, "library");
  await initStoryDropdown(storiesRoot);
});

after(async () => {
  await resetVectorStoreCacheForTest();
  restoreHome();
  fs.rmSync(base, { recursive: true, force: true });
});

test("toggle off: nothing happens", async () => {
  assert.deepEqual(await handleCreateStoryFromChat(reader({ "newStory.create": false }), storiesRoot), {
    status: "not-requested",
  });
});

test("create from chat, then select via override: indexes the title folder minus chapter_raw", async () => {
  const titleDir = path.join(base, "titles", "The Glass Orchard");
  writeFiles(titleDir, {
    "chapter_md/01.md": "orchardine chapter saga",
    "chapter_raw/01.txt": "RAWDUP orchardine raw saga",
    "characters/mira.md": "orchardine mira saga",
  });

  const client = makeFakeClient();
  const chat = makeCtl(
    { "newStory.create": true, "newStory.titleDir": titleDir, "newStory.embeddingModel": "fake-embedder" },
    client,
    { storiesRoot },
  );
  const message = userMessage("hello");
  assert.equal(await preprocess(chat.ctl, message), message, "no story selected yet: RAG stays off");
  assert.ok(chat.statuses.some((s) => s.text.startsWith('Created story "The Glass Orchard" (the-glass-orchard)')));
  assert.equal(client.calls.embeds, 0, "creating a story does not index it by itself");

  const loaded = await loadStory(storiesRoot, "the-glass-orchard");
  assert.ok(loaded.ok);
  if (!loaded.ok) return;
  assert.deepEqual(loaded.manifest.excludePatterns, ["**/chapter_raw/**"]);
  assert.equal(loaded.manifest.embedding.modelId, "fake-embedder");

  // Toggle still ON on the next message: idempotent, reports "already exists".
  chat.setChat({ storyId: "the-glass-orchard" });
  chat.statuses.length = 0;
  const prompt = textOf(await preprocess(chat.ctl, userMessage("orchardine saga")));
  assert.ok(chat.statuses.some((s) => s.text.startsWith("Already exists: story")));
  assert.ok(!chat.statuses.some((s) => s.status === "error"));
  assert.ok(prompt.includes("orchardine") && !prompt.includes("RAWDUP"));

  const store = new VectorStore(loaded.story.indexDir);
  await store.initialize();
  const files = Array.from(new Set((await store.listChunks()).map((c) => path.relative(titleDir, c.metadata.filePath)))).sort();
  assert.deepEqual(files, [path.join("chapter_md", "01.md"), path.join("characters", "mira.md")]);
});

test("custom id and excludes from the chat fields are honored", async () => {
  const titleDir = path.join(base, "titles", "Second Book");
  fs.mkdirSync(titleDir, { recursive: true });
  const result = await handleCreateStoryFromChat(
    reader({
      "newStory.create": true,
      "newStory.titleDir": titleDir,
      "newStory.id": "book-two",
      "newStory.excludePatterns": "drafts/**\n# comment\n**/chapter_raw/**",
    }),
    storiesRoot,
  );
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  assert.equal(result.story.id, "book-two");
  assert.deepEqual(result.story.excludePatterns, ["drafts/**", "**/chapter_raw/**"]);
});

test("errors: missing folder, empty folder field, bad id, id taken, overlapping sources", async () => {
  const missing = await handleCreateStoryFromChat(
    reader({ "newStory.create": true, "newStory.titleDir": path.join(base, "nope") }),
    storiesRoot,
  );
  assert.equal(missing.status, "error");
  assert.match((missing as { message: string }).message, /title folder not found/);

  const empty = await handleCreateStoryFromChat(reader({ "newStory.create": true }), storiesRoot);
  assert.match((empty as { message: string }).message, /fill in/);

  const otherTitle = path.join(base, "titles", "Other");
  fs.mkdirSync(otherTitle, { recursive: true });
  const badId = await handleCreateStoryFromChat(
    reader({ "newStory.create": true, "newStory.titleDir": otherTitle, "newStory.id": "Bad Id" }),
    storiesRoot,
  );
  assert.match((badId as { message: string }).message, /not a valid id/);

  const taken = await handleCreateStoryFromChat(
    reader({ "newStory.create": true, "newStory.titleDir": otherTitle, "newStory.id": "book-two" }),
    storiesRoot,
  );
  assert.match((taken as { message: string }).message, /already used by another title folder/);

  const nested = path.join(base, "titles", "The Glass Orchard", "characters");
  const overlap = await handleCreateStoryFromChat(
    reader({ "newStory.create": true, "newStory.titleDir": nested, "newStory.id": "nested" }),
    storiesRoot,
  );
  assert.match((overlap as { message: string }).message, /overlaps story "the-glass-orchard"/);
  assert.ok(!fs.existsSync(path.join(storiesRoot, "stories", "nested")));
});

test("chat status shows the creation error", async () => {
  const chat = makeCtl({ "newStory.create": true }, makeFakeClient(), { storiesRoot });
  await preprocess(chat.ctl, userMessage("x"));
  assert.ok(chat.statuses.some((s) => s.status === "error" && s.text.includes("fill in 'New story: title folder'")));
  void createStory;
});
