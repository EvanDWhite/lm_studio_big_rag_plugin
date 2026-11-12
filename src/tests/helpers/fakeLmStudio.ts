import * as fs from "node:fs";
import * as path from "node:path";
import { type ChatMessage, type PromptPreprocessorController, type ToolsProviderController } from "@lmstudio/sdk";

/** Fake LM Studio pieces so plugin code can run in node:test without LM Studio. */

export const FAKE_DIMS = 32;

/** Deterministic hashed bag-of-words embedding. */
export function fakeVector(text: string): number[] {
  const vector = new Array<number>(FAKE_DIMS).fill(0);
  for (const word of text.toLowerCase().split(/\W+/)) {
    if (!word) continue;
    let hash = 0;
    for (let i = 0; i < word.length; i++) hash = (hash * 31 + word.charCodeAt(i)) >>> 0;
    vector[hash % FAKE_DIMS] += 1;
  }
  vector[0] += 0.001;
  return vector;
}

export interface FakeClient {
  embedding: { model: (id: string) => Promise<{ embed: (text: string) => Promise<{ embedding: number[] }> }> };
  system: { notify: () => Promise<void> };
  /** Counters for assertions. */
  calls: { modelLoads: number; embeds: number; embeddedTexts: string[] };
}

export function makeFakeClient(beforeEmbed?: (text: string) => Promise<void>): FakeClient {
  const calls = { modelLoads: 0, embeds: 0, embeddedTexts: [] as string[] };
  const embedder = {
    embed: async (text: string) => {
      calls.embeds++;
      calls.embeddedTexts.push(text);
      if (beforeEmbed) await beforeEmbed(text);
      return { embedding: fakeVector(text) };
    },
  };
  return {
    embedding: {
      model: async () => {
        calls.modelLoads++;
        return embedder;
      },
    },
    system: { notify: async () => undefined },
    calls,
  };
}

export const CHAT_DEFAULTS: Record<string, unknown> = {
  storyId: "",
  documentsDirectory: "",
  vectorStoreDirectory: "",
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

export interface FakeCtl {
  ctl: PromptPreprocessorController & ToolsProviderController;
  statuses: Array<{ status: string; text: string }>;
  setChat: (values: Record<string, unknown>) => void;
}

export function makeCtl(
  chat: Record<string, unknown>,
  client: FakeClient,
  global: Record<string, unknown> = {},
): FakeCtl {
  let values = { ...CHAT_DEFAULTS, ...chat };
  const statuses: Array<{ status: string; text: string }> = [];
  const ctl = {
    abortSignal: new AbortController().signal,
    client,
    getPluginConfig: () => ({ get: (key: string) => values[key] }),
    getGlobalPluginConfig: () => ({ get: (key: string) => global[key] ?? "" }),
    createStatus: (state: { status: string; text: string }) => {
      statuses.push({ ...state });
      return { setState: (next: { status: string; text: string }) => statuses.push({ ...next }) };
    },
    debug: () => undefined,
    tokenSource: async () => ({}),
    pullHistory: async () => ({ withAppended: () => ({}) }),
  };
  return {
    ctl: ctl as unknown as PromptPreprocessorController & ToolsProviderController,
    statuses,
    setChat: (next) => {
      values = { ...values, ...next };
    },
  };
}

export function userMessage(text: string): ChatMessage {
  return { getText: () => text } as unknown as ChatMessage;
}

export function textOf(result: ChatMessage | string): string {
  return typeof result === "string" ? result : result.getText();
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** Point HOME at a temp dir so nothing touches the real ~/.lmstudio. Returns a restore fn. */
export function isolateHome(tempBase: string): () => void {
  const original = process.env.HOME;
  const originalStoriesEnv = process.env.BIG_RAG_STORIES_ROOT;
  process.env.HOME = path.join(tempBase, "home");
  delete process.env.BIG_RAG_STORIES_ROOT;
  fs.mkdirSync(process.env.HOME, { recursive: true });
  return () => {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    if (originalStoriesEnv === undefined) delete process.env.BIG_RAG_STORIES_ROOT;
    else process.env.BIG_RAG_STORIES_ROOT = originalStoriesEnv;
  };
}
