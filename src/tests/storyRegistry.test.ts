import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  chunkBelongsToStory,
  createStory,
  DEFAULT_STORY_EXCLUDES,
  getStoryDir,
  isValidStoryId,
  legacyStoryHandle,
  listStories,
  loadStory,
  resolveStoriesRoot,
  slugifyStoryId,
} from "../stories/storyRegistry";
import { isolateHome, writeFiles } from "./helpers/fakeLmStudio";

let base = "";
let restoreHome: () => void = () => undefined;

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "big-rag-registry-"));
  restoreHome = isolateHome(base);
});
after(() => {
  restoreHome();
  fs.rmSync(base, { recursive: true, force: true });
});

test("resolveStoriesRoot: setting > BIG_RAG_STORIES_ROOT > ~/.lmstudio/big-rag-stories", () => {
  assert.equal(resolveStoriesRoot("/x/stories", { BIG_RAG_STORIES_ROOT: "/env" }), path.resolve("/x/stories"));
  assert.equal(resolveStoriesRoot("  ", { BIG_RAG_STORIES_ROOT: "/env" }), path.resolve("/env"));
  assert.equal(resolveStoriesRoot("", {}), path.join(os.homedir(), ".lmstudio", "big-rag-stories"));
  assert.equal(resolveStoriesRoot("~/s", {}), path.join(os.homedir(), "s"));
});

test("story ids are validated and cannot escape the stories root", () => {
  assert.ok(isValidStoryId("the-salt-kingdom"));
  assert.ok(isValidStoryId("book_2"));
  for (const bad of ["", "../evil", "Upper", "a/b", "-lead", ".hidden", "x".repeat(65)]) {
    assert.ok(!isValidStoryId(bad), bad);
    assert.throws(() => getStoryDir(base, bad));
  }
  assert.equal(slugifyStoryId("The Salt Kingdom!"), "the-salt-kingdom");
  assert.equal(slugifyStoryId("Café Noir"), "cafe-noir");
});

test("createStory defaults: whole title folder, exclude chapter_raw, index under the story dir", async () => {
  const root = path.join(base, "root1");
  const titleDir = path.join(base, "titles", "The Salt Kingdom");
  writeFiles(titleDir, { "chapter_md/ch1.md": "x" });

  const story = await createStory(root, { titleDir });
  assert.equal(story.id, "the-salt-kingdom");
  assert.equal(story.displayName, "The Salt Kingdom");
  assert.deepEqual(story.sourceDirs, [path.resolve(titleDir)]);
  assert.deepEqual(story.excludePatterns, [...DEFAULT_STORY_EXCLUDES]);
  assert.equal(story.indexDir, path.join(root, "stories", "the-salt-kingdom", "index"));
  assert.equal(story.failureRegistryPath, path.join(root, "stories", "the-salt-kingdom", ".big-rag-failures.json"));
  assert.equal(story.chunkStamp, "the-salt-kingdom");
  assert.equal(story.acceptUnstampedChunks, false);

  const manifest = JSON.parse(fs.readFileSync(story.manifestPath!, "utf-8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.sourceDirs, ["."]);
  assert.deepEqual(manifest.chunking, { chunkSize: 512, chunkOverlap: 100 });
  assert.equal(manifest.embedding.dimensions, null);
  assert.deepEqual(manifest.stats, { totalChunks: 0, uniqueFiles: 0, lastIndexedAt: null });

  const loaded = await loadStory(root, "the-salt-kingdom");
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.ok && loaded.story, story);

  await assert.rejects(createStory(root, { titleDir }), /already exists/);
});

test("excludes and chunking are configurable per story", async () => {
  const root = path.join(base, "root2");
  const titleDir = path.join(base, "titles", "Custom");
  fs.mkdirSync(titleDir, { recursive: true });
  const story = await createStory(root, {
    titleDir,
    excludePatterns: ["drafts/**"],
    chunkSize: 256,
    chunkOverlap: 32,
    embeddingModelId: "text-embedding-mxbai-embed-large-v1",
  });
  assert.deepEqual(story.excludePatterns, ["drafts/**"]);
  assert.equal(story.chunkSize, 256);
  assert.equal(story.chunkOverlap, 32);
  assert.equal(story.embeddingModelId, "text-embedding-mxbai-embed-large-v1");
});

test("overlapping title folders are rejected", async () => {
  const root = path.join(base, "root3");
  const titleDir = path.join(base, "titles", "Overlap");
  fs.mkdirSync(path.join(titleDir, "inner"), { recursive: true });
  await createStory(root, { titleDir });
  await assert.rejects(createStory(root, { id: "inner", titleDir: path.join(titleDir, "inner") }), /overlaps/);
  await assert.rejects(createStory(root, { id: "outer", titleDir: path.dirname(titleDir) }), /overlaps/);
  assert.deepEqual((await listStories(root)).map((s) => s.id), ["overlap"]);
});

test("loadStory reports missing and invalid stories", async () => {
  const root = path.join(base, "root4");
  const missing = await loadStory(root, "nope");
  assert.equal(missing.ok, false);
  assert.equal(!missing.ok && missing.reason, "not-found");

  const invalid = await loadStory(root, "../etc");
  assert.equal(!invalid.ok && invalid.reason, "invalid-id");

  const dir = path.join(root, "stories", "broken");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "story.json"), JSON.stringify({ id: "other", sourceDirs: ["/x"] }));
  const mismatch = await loadStory(root, "broken");
  assert.equal(!mismatch.ok && mismatch.reason, "invalid-manifest");

  fs.writeFileSync(
    path.join(dir, "story.json"),
    JSON.stringify({ id: "broken", sourceDirs: ["/x"], chunking: { chunkSize: 100, chunkOverlap: 100 } }),
  );
  const badChunking = await loadStory(root, "broken");
  assert.equal(!badChunking.ok && badChunking.reason, "invalid-manifest");

  fs.writeFileSync(path.join(dir, "story.json"), "{not json");
  const badJson = await loadStory(root, "broken");
  assert.equal(!badJson.ok && badJson.reason, "invalid-manifest");
});

test("chunkBelongsToStory: stories need their own stamp; legacy accepts only unstamped", () => {
  const story = {
    chunkStamp: "alpha",
    acceptUnstampedChunks: false,
  } as Parameters<typeof chunkBelongsToStory>[1];
  assert.ok(chunkBelongsToStory({ storyId: "alpha" }, story));
  assert.ok(!chunkBelongsToStory({ storyId: "beta" }, story));
  assert.ok(!chunkBelongsToStory({}, story));
  assert.ok(chunkBelongsToStory({}, { ...story, acceptUnstampedChunks: true }));

  const legacy = legacyStoryHandle({
    documentsDirs: ["/docs"],
    vectorStoreDir: "/store",
    embeddingModelId: "",
    chunkSize: 512,
    chunkOverlap: 100,
    enableOCR: false,
    excludePatterns: [],
    additionalExtensions: [],
  });
  assert.equal(legacy.kind, "legacy");
  assert.match(legacy.id, /^legacy:[0-9a-f]{12}$/);
  assert.ok(chunkBelongsToStory({}, legacy));
  assert.ok(!chunkBelongsToStory({ storyId: "alpha" }, legacy));
});
