import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type LMStudioClient } from "@lmstudio/sdk";
import { preprocess } from "../promptPreprocessor";
import { ensureVectorStore, resetVectorStoreCacheForTest, retrievePassages } from "../rag/retrieval";
import { createStory, loadStory, type StoryHandle } from "../stories/storyRegistry";
import { VectorStore } from "../vectorstore/vectorStore";
import {
  fakeVector,
  isolateHome,
  makeCtl,
  makeFakeClient,
  textOf,
  userMessage,
  writeFiles,
} from "./helpers/fakeLmStudio";

/**
 * Two stories laid out like Brian's title folders (chapter_raw / chapter_md / characters / …).
 * Asserts: each story's store holds only its own files, chunks are stamped with the story id,
 * chapter_raw is never indexed, retrieval never crosses, and the ownership filter drops foreign
 * or unstamped chunks even if they are physically present in a story's index.
 */

let base = "";
let storiesRoot = "";
let restoreHome: () => void = () => undefined;
let salt: StoryHandle;
let brass: StoryHandle;
let saltTitle = "";

function titleFolder(name: string, token: string): string {
  const dir = path.join(base, "titles", name);
  writeFiles(dir, {
    "chapter_md/ch01.md": `# Chapter 1\n\n${token} chapter one. The ${token} saga begins.`,
    "chapter_md/ch02.md": `# Chapter 2\n\n${token} chapter two continues the ${token} saga.`,
    "chapter_raw/ch01.txt": `RAWDUP ${token} chapter one raw duplicate saga.`,
    "chapter_raw/ch02.txt": `RAWDUP ${token} chapter two raw duplicate saga.`,
    "characters/hero.md": `${token} hero character sheet saga.`,
    "worldbuilding/places/capital.md": `${token} capital city lore saga.`,
  });
  return dir;
}

async function chunksIn(story: StoryHandle) {
  const store = new VectorStore(story.indexDir);
  await store.initialize();
  const chunks = await store.listChunks();
  await store.close();
  return chunks;
}

/** Story chunks store paths relative to the title folder (posix). */
function relFiles(chunks: Array<{ metadata: Record<string, any> }>, _titleDir: string): string[] {
  for (const c of chunks) {
    assert.ok(!path.isAbsolute(c.metadata.filePath), `expected relative path, got ${c.metadata.filePath}`);
  }
  return Array.from(new Set(chunks.map((c) => String(c.metadata.filePath)))).sort();
}

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "big-rag-stories-"));
  restoreHome = isolateHome(base);
  storiesRoot = path.join(base, "library");
  saltTitle = titleFolder("The Salt Kingdom", "vexmora");
  const brassTitle = titleFolder("Brass Nebula", "ilsanebula");
  salt = await createStory(storiesRoot, { titleDir: saltTitle, embeddingModelId: "fake-embedder" });
  brass = await createStory(storiesRoot, { titleDir: brassTitle, embeddingModelId: "fake-embedder" });
  await resetVectorStoreCacheForTest();
});

after(async () => {
  await resetVectorStoreCacheForTest();
  restoreHome();
  fs.rmSync(base, { recursive: true, force: true });
});

test("two story chats index concurrently, each only into its own store", async () => {
  // Slow embeddings so both first-run indexing jobs overlap (per-story locks, not one global lock).
  const slow = () => new Promise<void>((r) => setTimeout(r, 2));
  const global = { storiesRoot };
  const chatSalt = makeCtl({ storyId: salt.id }, makeFakeClient(slow), global);
  const chatBrass = makeCtl({ storyId: brass.id }, makeFakeClient(slow), global);

  const [saltResult, brassResult] = await Promise.all([
    preprocess(chatSalt.ctl, userMessage("vexmora saga")),
    preprocess(chatBrass.ctl, userMessage("ilsanebula saga")),
  ]);
  const saltPrompt = textOf(saltResult);
  const brassPrompt = textOf(brassResult);

  // Both indexed in the same round => neither was blocked by the other's lock.
  assert.ok(saltPrompt.includes("Citation") && saltPrompt.includes("vexmora"), saltPrompt);
  assert.ok(brassPrompt.includes("Citation") && brassPrompt.includes("ilsanebula"), brassPrompt);
  assert.ok(!saltPrompt.includes("ilsanebula") && !brassPrompt.includes("vexmora"), "retrieval crossed stories");
  assert.ok(!saltPrompt.includes("RAWDUP") && !brassPrompt.includes("RAWDUP"), "chapter_raw leaked into a prompt");
  assert.ok(chatSalt.statuses.some((s) => s.text.includes("Story: The Salt Kingdom (the-salt-kingdom)")));

  for (const [story, token, foreign] of [
    [salt, "vexmora", "ilsanebula"],
    [brass, "ilsanebula", "vexmora"],
  ] as const) {
    const chunks = await chunksIn(story);
    assert.ok(chunks.length > 0);
    for (const c of chunks) {
      assert.equal(c.metadata.storyId, story.id, "every chunk is stamped with its story id");
      assert.ok(c.id.startsWith(`${story.id}:`), "chunk ids are namespaced by story");
      assert.ok(String(c.metadata.text).includes(token));
      assert.ok(!String(c.metadata.text).includes(foreign));
      assert.ok(!String(c.metadata.filePath).split("/").includes("chapter_raw"), "chapter_raw indexed");
      assert.ok(!path.isAbsolute(c.metadata.filePath), "story paths are relative to the title folder");
      assert.equal(c.metadata.subfolder, String(c.metadata.filePath).split("/")[0]);
    }
    assert.deepEqual(relFiles(chunks, story.sourceDirs[0]), [
      "chapter_md/ch01.md",
      "chapter_md/ch02.md",
      "characters/hero.md",
      "worldbuilding/places/capital.md",
    ]);
  }

  // story.json records stats + embedding dimensions after indexing.
  const reloaded = await loadStory(storiesRoot, salt.id);
  assert.ok(reloaded.ok);
  if (reloaded.ok) {
    assert.equal(reloaded.manifest.stats.uniqueFiles, 4);
    assert.ok(reloaded.manifest.stats.totalChunks >= 4);
    assert.equal(reloaded.manifest.embedding.dimensions, 32);
    assert.ok(reloaded.manifest.stats.lastIndexedAt);
  }
  assert.ok(fs.existsSync(path.join(storiesRoot, "stories", salt.id, "index", "shard_000")));
});

test("ownership filter drops foreign-stamped and unstamped chunks inside a story's index", async () => {
  const store = await ensureVectorStore(salt.indexDir);
  const query = "intruder perfect match query";
  const vector = fakeVector(query);
  await store.addChunks([
    {
      id: "brass-nebula:planted-0",
      text: `${query} FOREIGN`,
      vector,
      filePath: "/planted/foreign.md",
      fileName: "foreign.md",
      fileHash: "planted-foreign",
      chunkIndex: 0,
      metadata: { storyId: brass.id },
    },
    {
      id: "planted-unstamped-0",
      text: `${query} UNSTAMPED`,
      vector,
      filePath: "/planted/unstamped.md",
      fileName: "unstamped.md",
      fileHash: "planted-unstamped",
      chunkIndex: 0,
      metadata: {},
    },
  ]);
  try {
    const result = await retrievePassages({
      client: makeFakeClient() as unknown as LMStudioClient,
      story: salt,
      query,
      retrievalLimit: 20,
      retrievalThreshold: 0,
    });
    assert.ok(result.ok);
    if (result.ok) {
      assert.ok(result.passages.length > 0, "own chunks are still returned");
      for (const p of result.passages) {
        assert.ok(!p.text.includes("FOREIGN") && !p.text.includes("UNSTAMPED"), p.text);
        assert.equal(p.metadata.storyId, salt.id);
      }
    }

    // A story explicitly marked as a linked legacy store accepts unstamped chunks (migration aid).
    const linked = await retrievePassages({
      client: makeFakeClient() as unknown as LMStudioClient,
      story: { ...salt, acceptUnstampedChunks: true },
      query,
      retrievalLimit: 20,
      retrievalThreshold: 0,
    });
    assert.ok(linked.ok && linked.passages.some((p) => p.text.includes("UNSTAMPED")));
    assert.ok(linked.ok && !linked.passages.some((p) => p.text.includes("FOREIGN")));
  } finally {
    await store.deleteByFilePath("/planted/foreign.md");
    await store.deleteByFilePath("/planted/unstamped.md");
  }
});

test("reindex prunes files removed from the title folder; other story untouched", async () => {
  const brassBefore = (await chunksIn(brass)).map((c) => c.id).sort();
  fs.rmSync(path.join(saltTitle, "characters", "hero.md"));

  const chat = makeCtl(
    { storyId: salt.id, "manualReindex.trigger": true, "manualReindex.skipPreviouslyIndexed": true },
    makeFakeClient(),
    { storiesRoot },
  );
  await preprocess(chat.ctl, userMessage("vexmora"));

  assert.deepEqual(relFiles(await chunksIn(salt), saltTitle), [
    "chapter_md/ch01.md",
    "chapter_md/ch02.md",
    "worldbuilding/places/capital.md",
  ]);
  assert.ok(chat.statuses.some((s) => s.text === "Pruned (no longer in sources): 1"));
  assert.deepEqual((await chunksIn(brass)).map((c) => c.id).sort(), brassBefore);
});

test("excludes are configurable per story (chapter_raw can be opted back in)", async () => {
  const titleDir = titleFolder("Raw Included", "rawkeeper");
  const story = await createStory(storiesRoot, { titleDir, excludePatterns: [], embeddingModelId: "fake-embedder" });
  const chat = makeCtl({ storyId: story.id }, makeFakeClient(), { storiesRoot });
  await preprocess(chat.ctl, userMessage("rawkeeper"));
  const files = relFiles(await chunksIn(story), titleDir);
  assert.ok(files.includes("chapter_raw/ch01.txt"), files.join(","));
  assert.equal(files.length, 6);
});
