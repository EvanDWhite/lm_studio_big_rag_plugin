import { configSchematics, globalConfigSchematics, resolveEmbeddingModelId } from "../config";
import { parseDocumentPaths } from "../utils/documentPaths";
import { parseExcludePatternsBlock } from "../utils/fileExcludePatterns";
import { resolveAdditionalExtensions } from "../utils/additionalExtensions";
import { legacyStoryHandle, loadStory, resolveStoriesRoot, type StoryHandle } from "./storyRegistry";

/** Minimal key/value reader (ParsedConfig#get, or a plain object in tests). */
export interface ConfigReader {
  get(key: string): unknown;
}

export type StoryTarget =
  | { ok: true; story: StoryHandle; storiesRoot: string; warnings: string[] }
  | {
      ok: false;
      /** not-configured: nothing set (silent pass-through). Others: user error, show it. */
      reason: "not-configured" | "invalid-id" | "not-found" | "invalid-manifest" | "story-mismatch";
      message: string;
    };

function str(reader: ConfigReader | null, key: string): string {
  const v = reader?.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function num(reader: ConfigReader, key: string, fallback: number): number {
  const v = reader.get(key);
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export interface ResolveStoryTargetInput {
  chat: ConfigReader;
  global: ConfigReader | null;
  /** Story id passed explicitly by a tool call (REST). Must agree with the chat's own story. */
  explicitStoryId?: string;
}

/**
 * Decide which single story DB a chat / tool call may touch. Never consults shared or
 * "last used" state: the only inputs are this chat's config, the global stories root, and an
 * explicit story id. Anything unresolved fails closed (no indexing, no search).
 *
 * Precedence: chat Story ID > legacy (both legacy path fields set) > explicit tool story id
 * (only when the chat has no target of its own) > not configured.
 */
export async function resolveStoryTarget(input: ResolveStoryTargetInput): Promise<StoryTarget> {
  const { chat, global } = input;
  const storiesRoot = resolveStoriesRoot(str(global, "storiesRoot"));
  const chatStoryId = str(chat, "storyId");
  const explicit = (input.explicitStoryId ?? "").trim();
  const docsRaw = str(chat, "documentsDirectory");
  const storeRaw = str(chat, "vectorStoreDirectory");
  const warnings: string[] = [];

  if (chatStoryId) {
    if (explicit && explicit !== chatStoryId) {
      return {
        ok: false,
        reason: "story-mismatch",
        message: `This chat is bound to story "${chatStoryId}"; refusing a request for story "${explicit}".`,
      };
    }
    const loaded = await loadStory(storiesRoot, chatStoryId);
    if (!loaded.ok) return { ok: false, reason: loaded.reason, message: loaded.message };
    if (docsRaw || storeRaw) {
      warnings.push("Story ID is set, so the legacy Documents/Vector Store Directory fields are ignored.");
    }
    return { ok: true, story: loaded.story, storiesRoot, warnings };
  }

  if (docsRaw && storeRaw) {
    if (explicit) {
      return {
        ok: false,
        reason: "story-mismatch",
        message: `This chat uses a legacy vector store; refusing a request for story "${explicit}".`,
      };
    }
    const { additionalPlainTextSet } = resolveAdditionalExtensions(
      str(chat, "additionalExtensions"),
      (message) => console.warn(message),
    );
    const story = legacyStoryHandle({
      documentsDirs: parseDocumentPaths(docsRaw),
      vectorStoreDir: storeRaw,
      embeddingModelId: resolveEmbeddingModelId(str(chat, "embeddingModel")),
      chunkSize: num(chat, "chunkSize", 512),
      chunkOverlap: num(chat, "chunkOverlap", 100),
      enableOCR: chat.get("enableOCR") === true,
      excludePatterns: parseExcludePatternsBlock(str(chat, "excludeFilenamePatterns")),
      additionalExtensions: Array.from(additionalPlainTextSet),
    });
    return { ok: true, story, storiesRoot, warnings };
  }

  if (docsRaw || storeRaw) {
    return {
      ok: false,
      reason: "not-configured",
      message:
        "Big RAG: set a Story ID, or set BOTH legacy Documents Directory and Vector Store Directory. No search was run.",
    };
  }

  if (explicit) {
    const loaded = await loadStory(storiesRoot, explicit);
    if (!loaded.ok) return { ok: false, reason: loaded.reason, message: loaded.message };
    return { ok: true, story: loaded.story, storiesRoot, warnings };
  }

  return {
    ok: false,
    reason: "not-configured",
    message: "Big RAG: no story selected for this chat (set Story ID in the Big RAG settings). No search was run.",
  };
}

/** Controllers that expose plugin config (prompt preprocessor, tools provider). */
export interface PluginConfigSource {
  getPluginConfig: (schematics: typeof configSchematics) => { get(key: string): unknown };
  getGlobalPluginConfig?: (schematics: typeof globalConfigSchematics) => { get(key: string): unknown };
}

export function readConfigReaders(ctl: PluginConfigSource): { chat: ConfigReader; global: ConfigReader | null } {
  const chatConfig = ctl.getPluginConfig(configSchematics);
  let global: ConfigReader | null = null;
  try {
    const g = ctl.getGlobalPluginConfig?.(globalConfigSchematics);
    if (g) global = { get: (key: string) => g.get(key as never) };
  } catch (error) {
    console.warn("[BigRAG] Could not read global plugin config; using default stories root.", error);
  }
  return { chat: { get: (key: string) => chatConfig.get(key as never) }, global };
}
