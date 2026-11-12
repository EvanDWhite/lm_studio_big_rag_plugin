import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ChatMessage, type PromptPreprocessorController } from "@lmstudio/sdk";
import { preprocess } from "../promptPreprocessor";
import { ensureVectorStore, resetVectorStoreCacheForTest } from "../rag/retrieval";
import { VectorStore, type DocumentChunk } from "../vectorstore/vectorStore";

/**
 * Regression tests for the Phase 0 race: two chats with different vectorStoreDirs running at the
 * same time must each read and write only their own store.
 *
 * Previously `preprocess` opened the store with `ensureVectorStore(dir)` and then re-read a
 * process-wide singleton via `getCachedVectorStore()` (also inside the manual-reindex path).
 * Opening a second chat's store closed the first chat's store and replaced the singleton, so an
 * in-flight chat could lose its store mid-index or pick up the other chat's instance.
 */

const DIMS = 32;

let tempBase = "";
let originalHome: string | undefined;

before(() => {
  tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "big-rag-concurrent-"));
  // preprocess syncs settings to ~/.lmstudio/big-rag-tools-config.json; keep that inside the temp dir.
  originalHome = process.env.HOME;
  process.env.HOME = path.join(tempBase, "home");
  fs.mkdirSync(process.env.HOME, { recursive: true });
});

after(async () => {
  await resetVectorStoreCacheForTest();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  fs.rmSync(tempBase, { recursive: true, force: true });
});

function fakeVector(text: string): number[] {
  const vector = new Array<number>(DIMS).fill(0);
  for (const word of text.toLowerCase().split(/\W+/)) {
    if (!word) continue;
    let hash = 0;
    for (let i = 0; i < word.length; i++) hash = (hash * 31 + word.charCodeAt(i)) >>> 0;
    vector[hash % DIMS] += 1;
  }
  vector[0] += 0.001; // never all-zero
  return vector;
}

interface FakeEmbedderOptions {
  /** Called before embedding each text; may delay to widen race windows. */
  beforeEmbed?: (text: string) => Promise<void>;
}

function makeFakeClient(options: FakeEmbedderOptions = {}) {
  const embedder = {
    embed: async (text: string) => {
      if (options.beforeEmbed) await options.beforeEmbed(text);
      return { embedding: fakeVector(text) };
    },
  };
  return {
    embedding: { model: async () => embedder },
    system: { notify: async () => undefined },
  };
}

function makeStoryDocs(name: string, token: string, fileCount: number): string {
  const dir = path.join(tempBase, `${name}-docs`);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(
      path.join(dir, `${name}-chapter-${i}.txt`),
      `${token} chapter ${i}. The ${token} saga continues with ${token} lore and ${token} characters.`,
    );
  }
  return dir;
}

function makeCtl(
  config: Record<string, unknown>,
  client: ReturnType<typeof makeFakeClient>,
): PromptPreprocessorController {
  const defaults: Record<string, unknown> = {
    embeddingModel: "fake-embedder",
    retrievalLimit: 5,
    retrievalAffinityThreshold: 0,
    chunkSize: 512,
    chunkOverlap: 0,
    maxConcurrentFiles: 1,
    parseDelayMs: 0,
    enableOCR: false,
    excludeFilenamePatterns: "",
    additionalExtensions: "",
    "manualReindex.trigger": false,
    "manualReindex.skipPreviouslyIndexed": true,
    promptTemplate: "",
  };
  const values = { ...defaults, ...config };
  const ctl = {
    abortSignal: new AbortController().signal,
    client,
    getPluginConfig: () => ({ get: (key: string) => values[key] }),
    createStatus: () => ({ setState: () => undefined }),
    debug: () => undefined,
    tokenSource: async () => ({}),
    pullHistory: async () => ({ withAppended: () => ({}) }),
  };
  return ctl as unknown as PromptPreprocessorController;
}

function userMessage(text: string): ChatMessage {
  return { getText: () => text } as unknown as ChatMessage;
}

async function readStoreFromDisk(dir: string): Promise<{ files: string[]; texts: string[] }> {
  const store = new VectorStore(dir);
  await store.initialize();
  const inventory = await store.getFileHashInventory();
  const files = Array.from(inventory.keys()).map((p) => path.basename(p)).sort();
  const texts: string[] = [];
  // Search with a broad query + threshold 0 to pull back every stored chunk text.
  const results = await store.search(fakeVector("chapter saga lore characters"), 1000, -1);
  for (const r of results) texts.push(r.text);
  await store.close();
  return { files, texts };
}

test("ensureVectorStore keeps a separate, still-usable instance per directory", async () => {
  await resetVectorStoreCacheForTest();
  const dirA = path.join(tempBase, "unit-store-a");
  const dirB = path.join(tempBase, "unit-store-b");

  const [a1, b1, a2, b2] = await Promise.all([
    ensureVectorStore(dirA),
    ensureVectorStore(dirB),
    ensureVectorStore(dirA),
    ensureVectorStore(dirB),
  ]);
  assert.equal(a1, a2, "same dir must share one instance");
  assert.equal(b1, b2, "same dir must share one instance");
  assert.notEqual(a1, b1, "different dirs must get different instances");

  // Opening B must not close A: A must still accept writes.
  const chunk = (id: string, text: string, file: string): DocumentChunk => ({
    id,
    text,
    vector: fakeVector(text),
    filePath: file,
    fileName: path.basename(file),
    fileHash: id,
    chunkIndex: 0,
    metadata: {},
  });
  await a1.addChunks([chunk("a-1", "alpha only", "/a/a.txt")]);
  await b1.addChunks([chunk("b-1", "beta only", "/b/b.txt")]);

  assert.deepEqual((await readStoreFromDisk(dirA)).files, ["a.txt"]);
  assert.deepEqual((await readStoreFromDisk(dirB)).files, ["b.txt"]);
});

test("two concurrent chats with different vectorStoreDirs only index their own documents", async () => {
  await resetVectorStoreCacheForTest();
  const docsA = makeStoryDocs("alpha", "vexmora", 4);
  const docsB = makeStoryDocs("beta", "ilsanebula", 3);
  const storeA = path.join(tempBase, "store-alpha");
  const storeB = path.join(tempBase, "store-beta");

  // Gate: pause chat A in the middle of its first-run indexing until chat B has fully run.
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => (releaseGate = resolve));
  let signalAIndexing!: () => void;
  const aIndexing = new Promise<void>((resolve) => (signalAIndexing = resolve));
  let gated = false;

  const clientA = makeFakeClient({
    beforeEmbed: async (text) => {
      if (!gated && text.includes("vexmora chapter")) {
        gated = true;
        signalAIndexing();
        await gate;
      }
    },
  });
  const clientB = makeFakeClient();

  const chatA = makeCtl({ documentsDirectory: docsA, vectorStoreDirectory: storeA }, clientA);
  const chatB = makeCtl({ documentsDirectory: docsB, vectorStoreDirectory: storeB }, clientB);

  const runA = preprocess(chatA, userMessage("Tell me about vexmora"));
  await aIndexing;

  // Chat B runs while chat A is mid-index (B's first-run index is skipped by the shared lock).
  await preprocess(chatB, userMessage("Tell me about ilsanebula"));

  releaseGate();
  const resultA = await runA;

  // Chat B again, now that the indexing lock is free: B indexes its own docs.
  const resultB = await preprocess(chatB, userMessage("Tell me about ilsanebula"));

  const onDiskA = await readStoreFromDisk(storeA);
  const onDiskB = await readStoreFromDisk(storeB);

  assert.deepEqual(
    onDiskA.files,
    ["alpha-chapter-0.txt", "alpha-chapter-1.txt", "alpha-chapter-2.txt", "alpha-chapter-3.txt"],
    "store A must contain exactly story A's files",
  );
  assert.deepEqual(
    onDiskB.files,
    ["beta-chapter-0.txt", "beta-chapter-1.txt", "beta-chapter-2.txt"],
    "store B must contain exactly story B's files",
  );
  assert.ok(onDiskA.texts.length > 0 && onDiskA.texts.every((t) => t.includes("vexmora") && !t.includes("ilsanebula")));
  assert.ok(onDiskB.texts.length > 0 && onDiskB.texts.every((t) => t.includes("ilsanebula") && !t.includes("vexmora")));

  // Retrieval injected into each chat's prompt must come only from its own story.
  const promptA = typeof resultA === "string" ? resultA : resultA.getText();
  const promptB = typeof resultB === "string" ? resultB : resultB.getText();
  assert.ok(promptA.includes("vexmora") && promptA.includes("Citation"), "chat A should get its own citations");
  assert.ok(!promptA.includes("ilsanebula"), "chat A must not see story B");
  assert.ok(promptB.includes("ilsanebula") && promptB.includes("Citation"), "chat B should get its own citations");
  assert.ok(!promptB.includes("vexmora"), "chat B must not see story A");
});

test("interleaved retrieval across two chats never crosses stores", async () => {
  // Reuse the stores built above; hammer both chats concurrently.
  const docsA = path.join(tempBase, "alpha-docs");
  const docsB = path.join(tempBase, "beta-docs");
  const storeA = path.join(tempBase, "store-alpha");
  const storeB = path.join(tempBase, "store-beta");
  const jitter = () => new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * 3)));
  const chatA = makeCtl({ documentsDirectory: docsA, vectorStoreDirectory: storeA }, makeFakeClient({ beforeEmbed: jitter }));
  const chatB = makeCtl({ documentsDirectory: docsB, vectorStoreDirectory: storeB }, makeFakeClient({ beforeEmbed: jitter }));

  const runs: Array<Promise<{ chat: "A" | "B"; text: string }>> = [];
  for (let i = 0; i < 20; i++) {
    runs.push(preprocess(chatA, userMessage("chapter saga")).then((r) => ({ chat: "A" as const, text: typeof r === "string" ? r : r.getText() })));
    runs.push(preprocess(chatB, userMessage("chapter saga")).then((r) => ({ chat: "B" as const, text: typeof r === "string" ? r : r.getText() })));
  }
  for (const { chat, text } of await Promise.all(runs)) {
    assert.ok(text.includes("Citation"), `chat ${chat} should get citations`);
    if (chat === "A") {
      assert.ok(!text.includes("ilsanebula"), "chat A leaked story B content");
    } else {
      assert.ok(!text.includes("vexmora"), "chat B leaked story A content");
    }
  }
});
