import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Tool } from "@lmstudio/sdk";
import { preprocess } from "../promptPreprocessor";
import { provideTools } from "../toolsProvider";
import { resetVectorStoreCacheForTest } from "../rag/retrieval";
import { createStory, type StoryHandle } from "../stories/storyRegistry";
import { isolateHome, makeCtl, makeFakeClient, userMessage, writeFiles } from "./helpers/fakeLmStudio";

/**
 * Fail-closed behavior: when no story resolves for a chat, nothing is indexed or searched, even
 * if an old synced tools config file or BIG_RAG_* env vars point at a real store.
 */

let base = "";
let storiesRoot = "";
let restoreHome: () => void = () => undefined;
let alpha: StoryHandle;
let beta: StoryHandle;
const savedEnv: Record<string, string | undefined> = {};

async function callTool(tools: Tool[], name: string, params: Record<string, unknown>): Promise<any> {
  const found = tools.find((t) => t.name === name) as unknown as {
    implementation: (p: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
  };
  assert.ok(found, `tool ${name} missing`);
  return found.implementation(params, {
    status: () => undefined,
    warn: () => undefined,
    signal: new AbortController().signal,
  });
}

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "big-rag-failclosed-"));
  restoreHome = isolateHome(base);
  storiesRoot = path.join(base, "library");
  const alphaTitle = path.join(base, "titles", "Alpha");
  const betaTitle = path.join(base, "titles", "Beta");
  writeFiles(alphaTitle, { "chapter_md/a.md": "vexmora alpha saga" });
  writeFiles(betaTitle, { "chapter_md/b.md": "ilsanebula beta saga" });
  alpha = await createStory(storiesRoot, { titleDir: alphaTitle, embeddingModelId: "fake-embedder" });
  beta = await createStory(storiesRoot, { titleDir: betaTitle, embeddingModelId: "fake-embedder" });

  // Index both stories once.
  for (const story of [alpha, beta]) {
    await preprocess(makeCtl({ storyId: story.id }, makeFakeClient(), { storiesRoot }).ctl, userMessage("saga"));
  }

  // Old-version leftovers that previously acted as a silent fallback.
  const legacyStore = path.join(base, "legacy-store");
  fs.mkdirSync(path.join(process.env.HOME!, ".lmstudio"), { recursive: true });
  fs.writeFileSync(
    path.join(process.env.HOME!, ".lmstudio", "big-rag-tools-config.json"),
    JSON.stringify({ documentsDirectory: alphaTitle, vectorStoreDirectory: alpha.indexDir }),
  );
  for (const key of ["BIG_RAG_DOCS_DIR", "BIG_RAG_DB_DIR"]) savedEnv[key] = process.env[key];
  process.env.BIG_RAG_DOCS_DIR = alphaTitle;
  process.env.BIG_RAG_DB_DIR = alpha.indexDir;
  void legacyStore;
});

after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await resetVectorStoreCacheForTest();
  restoreHome();
  fs.rmSync(base, { recursive: true, force: true });
});

test("preprocess with no story and no legacy paths passes the message through untouched", async () => {
  const client = makeFakeClient();
  const chat = makeCtl({}, client, { storiesRoot });
  const message = userMessage("tell me about vexmora");
  const result = await preprocess(chat.ctl, message);
  assert.equal(result, message, "message must be returned unchanged");
  assert.equal(client.calls.modelLoads, 0, "no embedding model may be loaded");
  assert.equal(client.calls.embeds, 0);
});

test("preprocess with an unknown or invalid story id fails closed with an error status", async () => {
  for (const storyId of ["no-such-story", "../alpha", "Alpha"]) {
    const client = makeFakeClient();
    const chat = makeCtl({ storyId }, client, { storiesRoot });
    const message = userMessage("tell me about vexmora");
    assert.equal(await preprocess(chat.ctl, message), message);
    assert.equal(client.calls.embeds, 0);
    assert.ok(chat.statuses.some((s) => s.status === "error" && s.text.includes("No search was run")), storyId);
  }
  assert.ok(!fs.existsSync(path.join(storiesRoot, "stories", "no-such-story")), "must not create a store");
});

test("preprocess with only one legacy path set fails closed", async () => {
  const client = makeFakeClient();
  const chat = makeCtl({ documentsDirectory: path.join(base, "titles", "Alpha") }, client, { storiesRoot });
  const message = userMessage("vexmora");
  assert.equal(await preprocess(chat.ctl, message), message);
  assert.equal(client.calls.embeds, 0);
});

test("tools with no chat story and no story argument refuse (no synced-file or env fallback)", async () => {
  const client = makeFakeClient();
  const tools = await provideTools(makeCtl({}, client, { storiesRoot }).ctl);
  const search = await callTool(tools, "big_rag_stories_search", { query: "vexmora" });
  assert.equal(typeof search, "string");
  assert.match(search, /^Error: No story selected/);
  const status = await callTool(tools, "big_rag_stories_index_status", {});
  assert.match(status, /^Error: No story selected/);
  assert.equal(client.calls.embeds, 0);
});

test("a chat bound to one story cannot be redirected to another via the tool argument", async () => {
  const client = makeFakeClient();
  const tools = await provideTools(makeCtl({ storyId: alpha.id }, client, { storiesRoot }).ctl);
  const refused = await callTool(tools, "big_rag_stories_search", { query: "ilsanebula", story: beta.id });
  assert.match(refused, /bound to story "alpha"/);
  assert.equal(client.calls.embeds, 0);

  const own = await callTool(tools, "big_rag_stories_search", { query: "saga" });
  assert.equal(own.story, alpha.id);
  assert.ok(own.passageCount > 0);
  assert.ok(own.passages.every((p: { text: string }) => p.text.includes("vexmora")));

  const legacyTools = await provideTools(
    makeCtl({ documentsDirectory: "/d", vectorStoreDirectory: path.join(base, "legacy") }, client, { storiesRoot }).ctl,
  );
  assert.match(await callTool(legacyTools, "big_rag_stories_search", { query: "x", story: beta.id }), /legacy vector store/);
});

test("REST-style call (no chat config) with an explicit story searches only that story", async () => {
  const tools = await provideTools(makeCtl({}, makeFakeClient(), { storiesRoot }).ctl);
  const result = await callTool(tools, "big_rag_stories_search", { query: "saga", story: beta.id });
  assert.equal(result.story, beta.id);
  assert.ok(result.passageCount > 0);
  assert.ok(result.passages.every((p: { text: string }) => p.text.includes("ilsanebula") && !p.text.includes("vexmora")));

  const status = await callTool(tools, "big_rag_stories_index_status", { story: beta.id });
  assert.equal(status.storyId, beta.id);
  assert.equal(status.uniqueFiles, 1);

  assert.match(await callTool(tools, "big_rag_stories_search", { query: "saga", story: "missing" }), /not found/);
});
