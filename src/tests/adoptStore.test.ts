import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type LMStudioClient } from "@lmstudio/sdk";
import { runIndexingJob } from "../ingestion/runIndexing";
import { preprocess, resetSanityCheckMemoForTest } from "../promptPreprocessor";
import { resetVectorStoreCacheForTest } from "../rag/retrieval";
import { adoptLegacyStore, commonAncestor, formatAdoptReport, inferChunking } from "../stories/adoptStore";
import { legacyStoryHandle, loadStory as loadStoryResult, type StoryHandle } from "../stories/storyRegistry";

async function loadStory(root: string, id: string): Promise<StoryHandle> {
  const r = await loadStoryResult(root, id);
  if (!r.ok) throw new Error(`story ${id} not loadable`);
  return r.story;
}
import { VectorStore } from "../vectorstore/vectorStore";
import { isolateHome, makeCtl, makeFakeClient, textOf, userMessage, writeFiles } from "./helpers/fakeLmStudio";

/**
 * adopt-store: turn a legacy single store into a story without re-embedding.
 * The legacy store is built by the real indexer (fake embedder), exactly as the old plugin did.
 */

let base = "";
let restoreHome: () => void = () => undefined;

const LONG = (token: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${token}${i % 7} word${i}`).join(" ");

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "bigrag-adopt-"));
  restoreHome = isolateHome(base);
});
after(() => {
  restoreHome();
  fs.rmSync(base, { recursive: true, force: true });
});

/** Snapshot every file under dir -> sha256 (for "untouched" / "wrote nothing" checks). */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(path.relative(dir, full), crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}

interface Scenario {
  dir: string;
  titleDir: string;
  storeDir: string;
  storiesRoot: string;
  legacyChunks: number;
}

/** Build a legacy store over `docsDirs` (absolute file paths, unstamped ids), like the old plugin. */
async function buildLegacyStore(name: string, files: Record<string, string>, docsSub: string[]): Promise<Scenario> {
  const dir = path.join(base, name);
  writeFiles(dir, files);
  const titleDir = path.join(dir, "MyTitle");
  const storeDir = path.join(dir, "old-store");
  const legacy = legacyStoryHandle({
    documentsDirs: docsSub.map((d) => path.join(dir, d)),
    vectorStoreDir: storeDir,
    embeddingModelId: "fake-embedder",
    chunkSize: 8,
    chunkOverlap: 2,
    enableOCR: false,
    excludePatterns: [],
    additionalExtensions: [],
  });
  const client = makeFakeClient();
  const { stats } = await runIndexingJob({
    client: client as unknown as LMStudioClient,
    abortSignal: new AbortController().signal,
    story: legacy,
    maxConcurrent: 1,
    parseDelayMs: 0,
    autoReindex: true,
  });
  return { dir, titleDir, storeDir, storiesRoot: path.join(dir, "stories"), legacyChunks: stats.totalChunks };
}

async function chunksOf(story: StoryHandle) {
  const store = new VectorStore(story.indexDir);
  await store.initialize();
  const chunks = await store.listChunks();
  await store.close();
  return chunks;
}

function readItems(indexDir: string): Array<{ id: string; metadata: Record<string, any>; vector: number[] }> {
  return fs
    .readdirSync(indexDir)
    .filter((n) => n.startsWith("shard_"))
    .flatMap((n) => JSON.parse(fs.readFileSync(path.join(indexDir, n, "index.json"), "utf-8")).items);
}

// Scenario A: the old store indexed the title's chapter_md + characters (not chapter_raw) plus
// an unrelated notes folder outside the title.
const FILES_A = {
  "MyTitle/chapter_md/01.md": `# One\n\n${LONG("zorvak", 30)}`,
  "MyTitle/chapter_md/02.md": `# Two\n\n${LONG("quillon", 30)}`,
  "MyTitle/characters/mira.md": `Mira ${LONG("mirath", 20)}`,
  "MyTitle/chapter_raw/01.txt": `raw ${LONG("rawdup", 20)}`,
  "notes/misc.md": `misc ${LONG("outsider", 20)}`,
};

test("dry run: detects settings, reports inside/outside + first-reindex plan, writes nothing", async () => {
  const s = await buildLegacyStore("dry", FILES_A, ["MyTitle/chapter_md", "MyTitle/characters", "notes"]);
  const before = snapshot(s.dir);
  const report = await adoptLegacyStore({ storeDir: s.storeDir, titleDir: s.titleDir, storiesRoot: s.storiesRoot, dryRun: true });

  assert.deepEqual(snapshot(s.dir), before, "dry run must not write anything");
  assert.ok(!fs.existsSync(s.storiesRoot), "stories root not even created");

  assert.equal(report.totalChunks, s.legacyChunks);
  assert.equal(report.totalFiles, 4);
  assert.deepEqual(report.embedding, { modelId: "fake-embedder", dimensions: 32, source: "manifest" });
  assert.equal(report.chunking.source, "inferred");
  assert.equal(report.chunking.chunkSize, 8);
  assert.equal(report.chunking.chunkOverlap, 2);
  assert.equal(report.oldDocumentsFolder, s.dir);
  assert.equal(report.storyId, "mytitle");
  assert.equal(report.inside.files, 3);
  assert.equal(report.outside.files, 1);
  assert.equal(report.firstReindex.unchanged.files, 3);
  assert.equal(report.firstReindex.prune.files, 1);
  assert.equal(report.firstReindex.prune.byReason["outside-title-folder"], 1);
  assert.equal(report.firstReindex.newFiles.files, 0, "chapter_raw is excluded, so not 'new'");
  assert.deepEqual(report.errors, []);
  const text = formatAdoptReport(report);
  assert.match(text, /DRY RUN/);
  assert.match(text, /⚠ 1 file\(s\) .* will be PRUNED by the first reindex/);
  assert.match(text, /notes\/misc\.md|misc\.md \(outside-title-folder\)/);
});

test("copy adopt: original byte-untouched, embedder never called, ids namespaced, paths relative, vectors identical", async () => {
  const s = await buildLegacyStore("copy", FILES_A, ["MyTitle/chapter_md", "MyTitle/characters", "notes"]);
  const storeBefore = snapshot(s.storeDir);
  const oldItems = readItems(s.storeDir);

  // adoptLegacyStore takes no client at all; prove nothing embeds by running retrieval later
  // with a counting client and checking only the query is embedded.
  const report = await adoptLegacyStore({ storeDir: s.storeDir, titleDir: s.titleDir, storiesRoot: s.storiesRoot, displayName: "My Title" });
  assert.deepEqual(snapshot(s.storeDir), storeBefore, "original store untouched");

  const story = await loadStory(s.storiesRoot, "mytitle");
  assert.equal(story.displayName, "My Title");
  assert.equal(story.embeddingModelId, "fake-embedder");
  assert.equal(story.chunkSize, 8);
  assert.equal(story.chunkOverlap, 2);
  assert.deepEqual(story.excludePatterns, ["**/chapter_raw/**"]);
  const manifest = JSON.parse(fs.readFileSync(story.manifestPath!, "utf-8"));
  assert.equal(manifest.migration.mode, "copy");
  assert.equal(manifest.migration.sourceStore, s.storeDir);
  assert.equal(manifest.stats.totalChunks, s.legacyChunks);
  assert.equal(report.chunksAdopted, s.legacyChunks);

  const newItems = readItems(story.indexDir);
  assert.equal(newItems.length, oldItems.length);
  const oldById = new Map(oldItems.map((i) => [i.id, i]));
  for (const item of newItems) {
    assert.ok(item.id.startsWith("mytitle:"), item.id);
    const old = oldById.get(item.id.slice("mytitle:".length))!;
    assert.ok(old, `no source chunk for ${item.id}`);
    assert.deepEqual(item.vector, old.vector, "vector unchanged");
    assert.equal(item.metadata.storyId, "mytitle");
    assert.equal(item.metadata.text, old.metadata.text);
    if (old.metadata.filePath.startsWith(s.titleDir + path.sep)) {
      assert.equal(item.metadata.filePath, path.relative(s.titleDir, old.metadata.filePath).split(path.sep).join("/"));
      assert.equal(item.metadata.subfolder, item.metadata.filePath.split("/")[0]);
    } else {
      assert.equal(item.metadata.filePath, old.metadata.filePath, "outside files keep absolute paths");
    }
  }

  // Retrieval through the plugin: only the query is embedded, never the documents.
  resetVectorStoreCacheForTest();
  resetSanityCheckMemoForTest();
  const client = makeFakeClient();
  const chat = makeCtl({ storyId: "mytitle", embeddingModel: "fake-embedder" }, client, { storiesRoot: s.storiesRoot });
  const prompt = textOf(await preprocess(chat.ctl, userMessage("zorvak3 word")));
  assert.match(prompt, /zorvak/);
  assert.match(prompt, /chapter_md\/01\.md/, "citation shows the relative path");
  assert.deepEqual(
    client.calls.embeddedTexts.filter((t) => t !== "."),
    ["zorvak3 word"],
    "documents were not re-embedded",
  );
  resetVectorStoreCacheForTest();

  // Second adopt to the same id refuses (story exists) and writes nothing new.
  await assert.rejects(
    adoptLegacyStore({ storeDir: s.storeDir, titleDir: s.titleDir, storiesRoot: s.storiesRoot }),
    /Refusing to adopt[\s\S]*already exists/,
  );
});

test("first reindex after adopt: skips unchanged, re-embeds only changed/new, prunes outside (with warning)", async () => {
  const s = await buildLegacyStore("reindex", FILES_A, ["MyTitle/chapter_md", "MyTitle/characters", "notes"]);
  await adoptLegacyStore({ storeDir: s.storeDir, titleDir: s.titleDir, storiesRoot: s.storiesRoot });
  const story = await loadStory(s.storiesRoot, "mytitle");

  fs.writeFileSync(path.join(s.titleDir, "chapter_md/02.md"), `# Two (edited)\n\n${LONG("quillon", 12)}`);
  writeFiles(s.titleDir, { "worldbuilding/capital.md": "the capital city lore" });

  const client = makeFakeClient();
  const progress: string[] = [];
  const { indexingResult } = await runIndexingJob({
    client: client as unknown as LMStudioClient,
    abortSignal: new AbortController().signal,
    story,
    maxConcurrent: 1,
    parseDelayMs: 0,
    autoReindex: true,
    onProgress: (p) => progress.push(p.currentFile ?? ""),
  });
  assert.equal(indexingResult.skippedFiles, 2, "01.md and mira.md skipped");
  assert.equal(indexingResult.updatedFiles, 1);
  assert.equal(indexingResult.newFiles, 1);
  assert.equal(indexingResult.prunedFiles, 1);
  assert.ok(progress.some((p) => p.startsWith("⚠ Pruning 1 file(s)")), progress.join("\n"));
  assert.ok(!client.calls.embeddedTexts.some((t) => t.includes("zorvak") || t.includes("mirath")), "unchanged files not re-embedded");

  const chunks = await chunksOf(story);
  const files = [...new Set(chunks.map((c) => c.metadata.filePath))].sort();
  assert.deepEqual(files, ["chapter_md/01.md", "chapter_md/02.md", "characters/mira.md", "worldbuilding/capital.md"]);
  assert.ok(chunks.every((c) => c.metadata.storyId === "mytitle"));
});

test("--prune drops chunks the first reindex would prune (chapter_raw + outside); default keeps them", async () => {
  // This old store DID include chapter_raw (not Brian's case, but must be handled).
  const s = await buildLegacyStore("prune", FILES_A, ["MyTitle", "notes"]);
  const dry = await adoptLegacyStore({ storeDir: s.storeDir, titleDir: s.titleDir, storiesRoot: s.storiesRoot, dryRun: true });
  assert.equal(dry.excluded.files, 1, "chapter_raw/01.txt");
  assert.equal(dry.firstReindex.prune.byReason.excluded, 1);
  assert.equal(dry.firstReindex.prune.byReason["outside-title-folder"], 1);
  assert.equal(dry.chunksDropped, 0, "no deletion by default");

  const report = await adoptLegacyStore({ storeDir: s.storeDir, titleDir: s.titleDir, storiesRoot: s.storiesRoot, prune: true });
  assert.ok(report.chunksDropped > 0);
  const story = await loadStory(s.storiesRoot, "mytitle");
  const files = [...new Set((await chunksOf(story)).map((c) => c.metadata.filePath))].sort();
  assert.deepEqual(files, ["chapter_md/01.md", "chapter_md/02.md", "characters/mira.md"]);
  assert.equal(report.chunksAdopted + report.chunksDropped, s.legacyChunks);
});

test("--move relocates the store; old folder gone; story works", async () => {
  const s = await buildLegacyStore("move", FILES_A, ["MyTitle/chapter_md", "MyTitle/characters"]);
  const oldItems = readItems(s.storeDir);
  await adoptLegacyStore({ storeDir: s.storeDir, titleDir: s.titleDir, storiesRoot: s.storiesRoot, mode: "move", id: "moved" });
  assert.ok(!fs.existsSync(s.storeDir), "moved away");
  const story = await loadStory(s.storiesRoot, "moved");
  const items = readItems(story.indexDir);
  assert.equal(items.length, oldItems.length);
  assert.ok(items.every((i) => i.id.startsWith("moved:") && i.metadata.storyId === "moved"));
  assert.ok(fs.existsSync(path.join(story.indexDir, ".big-rag-embedding.json")));
});

test("documents moved since indexing: auto path map onto the title folder", async () => {
  const s = await buildLegacyStore("moved-docs", FILES_A, ["MyTitle/chapter_md", "MyTitle/characters"]);
  // Old paths were <dir>/MyTitle/...; the title now lives elsewhere.
  const newTitle = path.join(s.dir, "Library", "MyTitle");
  fs.mkdirSync(path.dirname(newTitle), { recursive: true });
  fs.renameSync(s.titleDir, newTitle);
  const report = await adoptLegacyStore({ storeDir: s.storeDir, titleDir: newTitle, storiesRoot: s.storiesRoot, dryRun: true });
  assert.equal(report.oldDocumentsFolder, s.titleDir);
  assert.deepEqual(report.pathMapsApplied, [{ from: s.titleDir, to: newTitle }]);
  assert.equal(report.inside.files, 3);
  assert.equal(report.firstReindex.unchanged.files, 3);
  assert.equal(report.firstReindex.prune.files, 0);
  assert.ok(report.warnings.some((w) => w.includes("auto-mapped")));

  const off = await adoptLegacyStore({ storeDir: s.storeDir, titleDir: newTitle, storiesRoot: s.storiesRoot, dryRun: true, autoPathMap: false });
  assert.equal(off.inside.files, 0);
  assert.ok(off.errors.some((e) => e.includes("None of the store's files are inside")), off.errors.join("\n"));
  await assert.rejects(
    adoptLegacyStore({ storeDir: s.storeDir, titleDir: newTitle, storiesRoot: s.storiesRoot, autoPathMap: false }),
    /Refusing to adopt/,
  );
  assert.ok(!fs.existsSync(s.storiesRoot), "refused run leaves nothing behind");
});

test("missing embedding manifest: needs --model; conflicting --model refused", async () => {
  const s = await buildLegacyStore("nomanifest", FILES_A, ["MyTitle/chapter_md"]);
  const conflict = await adoptLegacyStore({ storeDir: s.storeDir, titleDir: s.titleDir, storiesRoot: s.storiesRoot, dryRun: true, embeddingModelId: "other-model" });
  assert.ok(conflict.errors.some((e) => e.includes("conflicts")));
  fs.rmSync(path.join(s.storeDir, ".big-rag-embedding.json"));
  const dry = await adoptLegacyStore({ storeDir: s.storeDir, titleDir: s.titleDir, storiesRoot: s.storiesRoot, dryRun: true });
  assert.equal(dry.embedding.source, "missing");
  assert.equal(dry.embedding.dimensions, 32);
  assert.ok(dry.errors.some((e) => e.includes("--model")));
  await assert.rejects(adoptLegacyStore({ storeDir: s.storeDir, titleDir: s.titleDir, storiesRoot: s.storiesRoot }), /--model/);
  const ok = await adoptLegacyStore({ storeDir: s.storeDir, titleDir: s.titleDir, storiesRoot: s.storiesRoot, embeddingModelId: "fake-embedder" });
  assert.equal(ok.embedding.source, "flag");
  assert.equal((await loadStory(s.storiesRoot, "mytitle")).embeddingModelId, "fake-embedder");
});

test("adopting a store that is already a story store is refused", async () => {
  const s = await buildLegacyStore("twice", FILES_A, ["MyTitle/chapter_md"]);
  await adoptLegacyStore({ storeDir: s.storeDir, titleDir: s.titleDir, storiesRoot: s.storiesRoot });
  const story = await loadStory(s.storiesRoot, "mytitle");
  await assert.rejects(
    adoptLegacyStore({ storeDir: story.indexDir, titleDir: s.titleDir, storiesRoot: path.join(s.dir, "stories2") }),
    /already a story store/,
  );
});

test("helpers: chunking inference and common ancestor", () => {
  const meta = (filePath: string, startIndex: number, endIndex: number) => ({ metadata: { filePath, fileHash: filePath, startIndex, endIndex } });
  assert.deepEqual(
    inferChunking([meta("/a", 0, 512), meta("/a", 412, 700), meta("/b", 0, 512), meta("/b", 412, 924), meta("/b", 824, 900), meta("/c", 0, 30)]),
    { chunkSize: 512, chunkOverlap: 100, agreeing: 2, sampled: 2 },
  );
  assert.equal(inferChunking([meta("/c", 0, 30)]), null);
  assert.equal(commonAncestor(["/x/t/a/1.md", "/x/t/b/2.md", "/x/t/3.md"]), "/x/t");
  assert.equal(commonAncestor(["/x/t/a/1.md"]), "/x/t/a");
});

test("prune brake: a reindex that would prune more than half the files skips pruning with a warning", async () => {
  const s = await buildLegacyStore("brake", FILES_A, ["MyTitle/chapter_md", "MyTitle/characters"]);
  await adoptLegacyStore({ storeDir: s.storeDir, titleDir: s.titleDir, storiesRoot: s.storiesRoot });
  writeFiles(s.titleDir, { "worldbuilding/extra.md": "extra lore", "worldbuilding/more.md": "more lore" });
  const story = await loadStory(s.storiesRoot, "mytitle");
  // Simulate a wrong folder: 2 of 3 indexed files vanish (plus 2 new) -> 2/3 > 0.5 => no prune.
  fs.rmSync(path.join(s.titleDir, "chapter_md"), { recursive: true });
  const progress: string[] = [];
  const { indexingResult } = await runIndexingJob({
    client: makeFakeClient() as unknown as LMStudioClient,
    abortSignal: new AbortController().signal,
    story,
    maxConcurrent: 1,
    parseDelayMs: 0,
    autoReindex: true,
    onProgress: (p) => progress.push(p.currentFile ?? ""),
  });
  // Inventory has 3 files (< 4), so the brake does not apply to tiny stores: prune happens.
  assert.equal(indexingResult.prunedFiles, 2);

  // Bigger store: 4+ indexed files, 3 vanish -> brake.
  writeFiles(s.titleDir, { "chapter_md/a.md": "alpha lore", "chapter_md/b.md": "beta lore" });
  await runIndexingJob({ client: makeFakeClient() as unknown as LMStudioClient, abortSignal: new AbortController().signal, story, maxConcurrent: 1, parseDelayMs: 0, autoReindex: true });
  fs.rmSync(path.join(s.titleDir, "chapter_md"), { recursive: true });
  fs.rmSync(path.join(s.titleDir, "worldbuilding", "more.md"));
  const progress2: string[] = [];
  const second = await runIndexingJob({
    client: makeFakeClient() as unknown as LMStudioClient,
    abortSignal: new AbortController().signal,
    story,
    maxConcurrent: 1,
    parseDelayMs: 0,
    autoReindex: true,
    onProgress: (p) => progress2.push(p.currentFile ?? ""),
  });
  assert.equal(second.indexingResult.prunedFiles, 0);
  assert.ok(progress2.some((p) => p.startsWith("⚠ NOT pruning: 3 of 5")), progress2.join("\n"));
  void progress;
});
