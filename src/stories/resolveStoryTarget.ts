import {
  getConfigSchematics,
  globalConfigSchematics,
  NO_STORY_VALUE,
  resolveEmbeddingModelId,
  type BigRagConfigSchematics,
} from "../config";
import { getStoryPolicy, type StoryPolicy } from "./policy";
import { parseDocumentPaths } from "../utils/documentPaths";
import { parseExcludePatternsBlock } from "../utils/fileExcludePatterns";
import { resolveAdditionalExtensions } from "../utils/additionalExtensions";
import { legacyStoryHandle, loadStory, resolveStoriesRoot, type StoryHandle } from "./storyRegistry";

/** Minimal key/value reader (ParsedConfig#get, or a plain object in tests). */
export interface ConfigReader {
  get(key: string): unknown;
}

/** How the chat's story was chosen (shown in the status line). */
export type StorySelectionSource = "typed-override" | "dropdown" | "legacy-paths" | "tool-argument";

export type StoryTarget =
  | {
      ok: true;
      story: StoryHandle;
      storiesRoot: string;
      source: StorySelectionSource;
      warnings: string[];
    }
  | {
      ok: false;
      /** not-configured: nothing set (retrieval off). Others: user error, show it. */
      reason: "not-configured" | "invalid-id" | "not-found" | "invalid-manifest" | "story-mismatch" | "tool-arg-disabled";
      message: string;
      storiesRoot: string;
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
  /** Story id passed explicitly by a tool call (REST). Governed by the story policy. */
  explicitStoryId?: string;
  policy?: Readonly<StoryPolicy>;
}

/** The story id this chat selected (typed override wins over the dropdown), or "" for none. */
export function chatSelectedStoryId(chat: ConfigReader): { id: string; source: StorySelectionSource } | null {
  const typed = str(chat, "storyId");
  if (typed) return { id: typed, source: "typed-override" };
  const dropdown = str(chat, "story");
  if (dropdown && dropdown !== NO_STORY_VALUE) return { id: dropdown, source: "dropdown" };
  return null;
}

/**
 * Decide which single story DB a chat / tool call may touch. Never consults shared or
 * "last used" state: the only inputs are this chat's config, the global stories root, an
 * explicit tool story id, and the story policy. Anything unresolved fails closed.
 *
 * Precedence: typed Story ID override > dropdown > legacy (both legacy path fields set) >
 * explicit tool story id (only when the chat has no target, if policy allows) > not configured.
 */
export async function resolveStoryTarget(input: ResolveStoryTargetInput): Promise<StoryTarget> {
  const { chat, global } = input;
  const policy = input.policy ?? getStoryPolicy();
  const storiesRoot = resolveStoriesRoot(str(global, "storiesRoot"));
  const selected = chatSelectedStoryId(chat);
  const explicit = (input.explicitStoryId ?? "").trim();
  const docsRaw = str(chat, "documentsDirectory");
  const storeRaw = str(chat, "vectorStoreDirectory");
  const warnings: string[] = [];
  const fail = (reason: Exclude<StoryTarget, { ok: true }>["reason"], message: string): StoryTarget => ({
    ok: false,
    reason,
    message,
    storiesRoot,
  });

  if (selected) {
    if (explicit && explicit !== selected.id && !policy.allowToolStoryArgOverride) {
      return fail(
        "story-mismatch",
        `This chat is bound to story "${selected.id}"; refusing a request for story "${explicit}".`,
      );
    }
    const id = explicit && policy.allowToolStoryArgOverride ? explicit : selected.id;
    const loaded = await loadStory(storiesRoot, id);
    if (!loaded.ok) return fail(loaded.reason, loaded.message);
    if (docsRaw || storeRaw) {
      warnings.push("A story is selected, so the legacy Documents/Vector Store Directory fields are ignored.");
    }
    return {
      ok: true,
      story: loaded.story,
      storiesRoot,
      source: id === selected.id ? selected.source : "tool-argument",
      warnings,
    };
  }

  if (docsRaw && storeRaw) {
    if (explicit) {
      return fail("story-mismatch", `This chat uses a legacy vector store; refusing a request for story "${explicit}".`);
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
    return { ok: true, story, storiesRoot, source: "legacy-paths", warnings };
  }

  if (docsRaw || storeRaw) {
    return fail(
      "not-configured",
      "Big RAG Stories: select a Story, or set BOTH legacy Documents Directory and Vector Store Directory. No search was run.",
    );
  }

  if (explicit) {
    if (!policy.allowToolStoryArgWhenChatHasNone) {
      return fail("tool-arg-disabled", `Selecting a story from a tool call is disabled; refusing story "${explicit}".`);
    }
    const loaded = await loadStory(storiesRoot, explicit);
    if (!loaded.ok) return fail(loaded.reason, loaded.message);
    return { ok: true, story: loaded.story, storiesRoot, source: "tool-argument", warnings };
  }

  return fail("not-configured", "Big RAG Stories is off for this chat: no story selected. No search was run.");
}

/** Controllers that expose plugin config (prompt preprocessor, tools provider). */
export interface PluginConfigSource {
  getPluginConfig: (schematics: BigRagConfigSchematics) => { get(key: string): unknown };
  getGlobalPluginConfig?: (schematics: typeof globalConfigSchematics) => { get(key: string): unknown };
}

/**
 * The chat's saved config could not be parsed with the schematics registered at startup. In
 * practice: the chat's saved dropdown value is a story that is no longer in the option list
 * (story deleted, or the plugin restarted with a different Stories Root). The SDK rejects
 * select values that are not among the options. Callers must fail closed.
 */
export class ChatConfigUnreadableError extends Error {
  constructor(cause: unknown) {
    super(
      "Big RAG Stories could not read this chat's settings. Most likely the selected Story is no longer in the " +
        "dropdown (deleted, or the plugin restarted with a different Stories Root). Pick a story again or use " +
        "Story ID override. No search was run.",
    );
    this.name = "ChatConfigUnreadableError";
    (this as { cause?: unknown }).cause = cause;
  }
}

export function readConfigReaders(ctl: PluginConfigSource): { chat: ConfigReader; global: ConfigReader | null } {
  let chatConfig: { get(key: string): unknown };
  try {
    chatConfig = ctl.getPluginConfig(getConfigSchematics());
  } catch (error) {
    throw new ChatConfigUnreadableError(error);
  }
  let global: ConfigReader | null = null;
  try {
    const g = ctl.getGlobalPluginConfig?.(globalConfigSchematics);
    if (g) global = { get: (key: string) => g.get(key as never) };
  } catch (error) {
    console.warn("[BigRAG-Stories] Could not read global plugin config; using default stories root.", error);
  }
  return { chat: { get: (key: string) => chatConfig.get(key as never) }, global };
}
