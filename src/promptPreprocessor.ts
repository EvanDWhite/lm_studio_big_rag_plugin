import {
  type ChatMessage,
  type PromptPreprocessorController,
} from "@lmstudio/sdk";
import { DEFAULT_PROMPT_TEMPLATE } from "./config";
import { performSanityChecks } from "./utils/sanityChecks";
import { tryStartIndexing, finishIndexing } from "./utils/indexingLock";
import { deleteEmbeddingIndexManifest } from "./utils/embeddingIndexManifest";
import * as path from "path";
import { runIndexingJob } from "./ingestion/runIndexing";
import { type IndexingProgress } from "./ingestion/indexManager";
import { type VectorStore } from "./vectorstore/vectorStore";
import { type StoryHandle } from "./stories/storyRegistry";
import {
  ChatConfigUnreadableError,
  readConfigReaders,
  resolveStoryTarget,
  type ConfigReader,
  type StorySelectionSource,
} from "./stories/resolveStoryTarget";
import { resolveStoriesRoot } from "./stories/storyRegistry";
import { getDropdownState, writeStoriesRootHint } from "./stories/storyDropdown";
import { handleCreateStoryFromChat } from "./stories/createFromChat";
import {
  ensureVectorStore,
  formatRagContext,
  retrievePassages,
  summarizeText,
} from "./rag/retrieval";

/**
 * Check the abort signal and throw if the request has been cancelled.
 * This gives LM Studio the opportunity to stop the preprocessor promptly.
 */
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

/**
 * Returns true if the error is an abort/cancellation error that should be re-thrown.
 */
function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  if (error instanceof Error && error.message === "Aborted") return true;
  return false;
}

/**
 * Sanity-check memo per story: story id -> signature of the paths that last passed.
 * Re-checked when that story's paths change; other stories are unaffected.
 */
const sanityCheckedSignatures = new Map<string, string>();

function sanitySignature(story: StoryHandle): string {
  return [...story.sourceDirs, "->", story.indexDir].join("\n");
}

/** @internal Test helper. */
export function resetSanityCheckMemoForTest(): void {
  sanityCheckedSignatures.clear();
}

const RAG_CONTEXT_MACRO = "{{rag_context}}";
const USER_QUERY_MACRO = "{{user_query}}";

function normalizePromptTemplate(template: string | null | undefined): string {
  const hasContent = typeof template === "string" && template.trim().length > 0;
  let normalized = hasContent ? template! : DEFAULT_PROMPT_TEMPLATE;

  if (!normalized.includes(RAG_CONTEXT_MACRO)) {
    console.warn(
      `[BigRAG-Stories] Prompt template missing ${RAG_CONTEXT_MACRO}. Prepending RAG context block.`,
    );
    normalized = `${RAG_CONTEXT_MACRO}\n\n${normalized}`;
  }

  if (!normalized.includes(USER_QUERY_MACRO)) {
    console.warn(
      `[BigRAG-Stories] Prompt template missing ${USER_QUERY_MACRO}. Appending user query block.`,
    );
    normalized = `${normalized}\n\nUser Query:\n\n${USER_QUERY_MACRO}`;
  }

  return normalized;
}

function fillPromptTemplate(template: string, replacements: Record<string, string>): string {
  return Object.entries(replacements).reduce(
    (acc, [token, value]) => acc.split(token).join(value),
    template,
  );
}

async function warnIfContextOverflow(
  ctl: PromptPreprocessorController,
  finalPrompt: string,
): Promise<void> {
  try {
    const tokenSource = await ctl.tokenSource();
    if (
      !tokenSource ||
      !("applyPromptTemplate" in tokenSource) ||
      typeof tokenSource.applyPromptTemplate !== "function" ||
      !("countTokens" in tokenSource) ||
      typeof tokenSource.countTokens !== "function" ||
      !("getContextLength" in tokenSource) ||
      typeof tokenSource.getContextLength !== "function"
    ) {
      console.warn("[BigRAG-Stories] Token source does not expose prompt utilities; skipping context check.");
      return;
    }

    const [contextLength, history] = await Promise.all([
      tokenSource.getContextLength(),
      ctl.pullHistory(),
    ]);
    const historyWithLatestMessage = history.withAppended({
      role: "user",
      content: finalPrompt,
    });
    const formattedPrompt = await tokenSource.applyPromptTemplate(historyWithLatestMessage);
    const promptTokens = await tokenSource.countTokens(formattedPrompt);

    if (promptTokens > contextLength) {
      const warningSummary =
        `⚠️ Prompt needs ${promptTokens.toLocaleString()} tokens but model max is ${contextLength.toLocaleString()}.`;
      console.warn("[BigRAG-Stories]", warningSummary);
      ctl.createStatus({
        status: "error",
        text: `${warningSummary} Reduce retrieved passages or increase the model's context length.`,
      });
      try {
        await ctl.client.system.notify({
          title: "Context window exceeded",
          description: `${warningSummary} Prompt may be truncated or rejected.`,
          noAutoDismiss: true,
        });
      } catch (notifyError) {
        console.warn("[BigRAG-Stories] Unable to send context overflow notification:", notifyError);
      }
    }
  } catch (error) {
    console.warn("[BigRAG-Stories] Failed to evaluate context usage:", error);
  }
}

function globalString(global: ConfigReader | null, key: string): string {
  const v = global?.get(key);
  return typeof v === "string" ? v : "";
}

const SOURCE_LABELS: Record<StorySelectionSource, string> = {
  "typed-override": "typed Story ID override",
  dropdown: "dropdown",
  "legacy-paths": "legacy paths",
  "tool-argument": "tool argument",
};

/** One line, shown on every reply, naming the story this chat searches and how it was chosen. */
export function storyStatusLine(story: StoryHandle, source: StorySelectionSource, storiesRoot: string): string {
  if (story.kind === "legacy") {
    return `📚 Big RAG Stories · legacy store: ${story.indexDir} (via ${SOURCE_LABELS[source]})`;
  }
  let line = `📚 Big RAG Stories · ${story.displayName} (${story.id}) · via ${SOURCE_LABELS[source]}`;
  const dropdown = getDropdownState();
  if (dropdown && path.resolve(dropdown.storiesRoot) !== path.resolve(storiesRoot)) {
    line += ` · dropdown lists ${dropdown.storiesRoot}, Stories Root is ${storiesRoot}: reload the plugin to refresh it`;
  } else if (dropdown && source === "typed-override" && !dropdown.storyIds.includes(story.id)) {
    line += " · not in the dropdown yet (reload the plugin to list it)";
  }
  return line;
}

async function reportCreateStoryRequest(
  ctl: PromptPreprocessorController,
  chat: ConfigReader,
  storiesRoot: string,
): Promise<void> {
  const result = await handleCreateStoryFromChat(chat, storiesRoot);
  if (result.status === "not-requested") return;
  if (result.status === "error") {
    console.warn(`[BigRAG-Stories] ${result.message}`);
    ctl.createStatus({ status: "error", text: result.message });
    return;
  }
  const verb = result.status === "created" ? "Created" : "Already exists:";
  const text =
    `${verb} story "${result.story.displayName}" (${result.story.id}) at ${result.story.manifestPath}. ` +
    `Select it with Story ID override = ${result.story.id} (or the dropdown after a plugin reload), ` +
    `then turn "Create story from title folder" OFF.`;
  console.info(`[BigRAG-Stories] ${text}`);
  ctl.createStatus({ status: "done", text });
}

/**
 * Main prompt preprocessor function
 */
export async function preprocess(
  ctl: PromptPreprocessorController,
  userMessage: ChatMessage,
): Promise<ChatMessage | string> {
  const userPrompt = userMessage.getText();
  let readers: ReturnType<typeof readConfigReaders>;
  try {
    readers = readConfigReaders(ctl);
  } catch (error) {
    if (error instanceof ChatConfigUnreadableError) {
      console.warn(`[BigRAG-Stories] ${error.message}`, (error as { cause?: unknown }).cause);
      ctl.createStatus({ status: "error", text: `📚 ${error.message}` });
      return userMessage;
    }
    throw error;
  }
  const { chat: chatConfig, global: globalConfig } = readers;

  // Optional "Create story from title folder" toggle (writes only under the stories root).
  await reportCreateStoryRequest(ctl, chatConfig, resolveStoriesRoot(globalString(globalConfig, "storiesRoot")));

  // Resolve exactly one story DB for this chat. Everything below uses only `story`.
  const target = await resolveStoryTarget({ chat: chatConfig, global: globalConfig });
  if (globalConfig) {
    // Lets the next plugin start list stories from the root chats actually use.
    writeStoriesRootHint(target.storiesRoot);
  }
  if (!target.ok) {
    const text = target.message.includes("No search was run") ? target.message : `${target.message} No search was run.`;
    if (target.reason === "not-configured") {
      console.info(`[BigRAG-Stories] ${text}`);
      ctl.createStatus({ status: "done", text: `📚 ${text}` });
    } else {
      console.warn(`[BigRAG-Stories] ${text}`);
      ctl.createStatus({ status: "error", text: `📚 ${text}` });
    }
    // Fail closed: no indexing, no retrieval, prompt passes through unchanged.
    return userMessage;
  }
  const story = target.story;
  ctl.createStatus({ status: "done", text: storyStatusLine(target.story, target.source, target.storiesRoot) });
  for (const warning of target.warnings) {
    console.warn(`[BigRAG-Stories] ${warning}`);
    ctl.createStatus({ status: "done", text: warning });
  }

  const retrievalLimit = chatConfig.get("retrievalLimit") as number;
  const retrievalThreshold = chatConfig.get("retrievalAffinityThreshold") as number;
  const maxConcurrent = chatConfig.get("maxConcurrentFiles") as number;
  const parseDelayMs = (chatConfig.get("parseDelayMs") as number | undefined) ?? 0;
  const reindexRequested = chatConfig.get("manualReindex.trigger") === true;
  const skipPreviouslyIndexed = chatConfig.get("manualReindex.skipPreviouslyIndexed") !== false;
  const resolvedEmbeddingModelId = story.embeddingModelId;

  if (story.sourceDirs.length === 0) {
    console.warn("[BigRAG-Stories] No source folders configured for this story.");
    return userMessage;
  }

  try {
    // Re-run sanity checks when this story's paths change or on its first run.
    const signature = sanitySignature(story);
    if (sanityCheckedSignatures.get(story.id) !== signature) {
      const checkStatus = ctl.createStatus({
        status: "loading",
        text: "Performing sanity checks...",
      });

      const sanityResult = await performSanityChecks(story.sourceDirs, story.indexDir);

      // Log warnings
      for (const warning of sanityResult.warnings) {
        console.warn("[BigRAG-Stories]", warning);
      }

      // Log errors and abort if critical
      if (!sanityResult.passed) {
        for (const error of sanityResult.errors) {
          console.error("[BigRAG-Stories]", error);
        }
        const failureReason =
          sanityResult.errors[0] ??
          sanityResult.warnings[0] ??
          "Unknown reason. Please review plugin settings.";
        checkStatus.setState({
          status: "canceled",
          text: `Sanity checks failed: ${failureReason}`,
        });
        return userMessage;
      }

      checkStatus.setState({
        status: "done",
        text: "Sanity checks passed",
      });
      sanityCheckedSignatures.set(story.id, signature);
    }

    checkAbort(ctl.abortSignal);

    // Initialize vector store if needed
    let vectorStore: VectorStore;
    {
      const status = ctl.createStatus({
        status: "loading",
        text: "Initializing vector store...",
      });

      // Use the instance opened for THIS chat's vectorStoreDir for every step below
      // (reindex, auto-index, stats). Never re-read shared state: another chat with a
      // different vectorStoreDir may be running concurrently.
      vectorStore = await ensureVectorStore(story.indexDir);
      status.setState({
        status: "done",
        text: "Vector store initialized",
      });
    }

    checkAbort(ctl.abortSignal);

    await maybeHandleConfigTriggeredReindex({
      ctl,
      story,
      maxConcurrent,
      parseDelayMs,
      reindexRequested,
      skipPreviouslyIndexed,
      vectorStore,
    });

    checkAbort(ctl.abortSignal);

    // Check if we need to index
    const stats = await vectorStore.getStats();
    console.debug(`[BigRAG-Stories] Vector store stats before auto-index check: totalChunks=${stats.totalChunks}, uniqueFiles=${stats.uniqueFiles}`);

    if (stats.totalChunks === 0) {
      if (!tryStartIndexing(story.indexDir, `auto-trigger:${story.id}`)) {
        console.warn("[BigRAG-Stories] Indexing already running, skipping automatic indexing.");
      } else {
        const indexStatus = ctl.createStatus({
          status: "loading",
          text: `Starting initial indexing… (embedding model: ${resolvedEmbeddingModelId})`,
        });

        try {
          const { indexingResult } = await runIndexingJob({
            client: ctl.client,
            abortSignal: ctl.abortSignal,
            story,
            vectorStore,
            maxConcurrent,
            parseDelayMs,
            autoReindex: false,
            forceReindex: true,
            onProgress: (progress) => reportProgress(indexStatus, progress, resolvedEmbeddingModelId),
          });

          console.log(`[BigRAG-Stories] Indexing complete: ${indexingResult.successfulFiles}/${indexingResult.totalFiles} files successfully indexed (${indexingResult.failedFiles} failed)`);
        } catch (error) {
          indexStatus.setState({
            status: "canceled",
            text: `Indexing failed: ${error instanceof Error ? error.message : String(error)}`,
          });
          console.error("[BigRAG-Stories] Indexing failed:", error);
        } finally {
          finishIndexing(story.indexDir);
        }
      }
    }

    checkAbort(ctl.abortSignal);

    // Log manual reindex toggle states for visibility on each chat
    const toggleStatusText =
      `Manual Reindex Trigger: ${reindexRequested ? "ON" : "OFF"} | ` +
      `Skip Previously Indexed: ${skipPreviouslyIndexed ? "ON" : "OFF"} | ` +
      `Embedding model: ${resolvedEmbeddingModelId}`;
    console.info(`[BigRAG-Stories] ${toggleStatusText}`);
    ctl.createStatus({
      status: "done",
      text: toggleStatusText,
    });

    const retrievalStats = await vectorStore.getStats();
    if (retrievalStats.totalChunks === 0) {
      await deleteEmbeddingIndexManifest(story.indexDir);
      ctl.createStatus({
        status: "canceled",
        text: `No documents indexed yet in ${story.displayName}`,
      });
      const noteAboutEmptyIndex =
        `Important: The document index is empty (no chunks stored yet). ` +
        `In one short sentence, tell the user that nothing has been indexed. ` +
        `Then answer their question to the best of your ability without claiming document retrieval.`;
      return noteAboutEmptyIndex + `\n\nUser Query:\n\n${userPrompt}`;
    }

    const retrievalStatus = ctl.createStatus({
      status: "loading",
      text: "Searching for relevant content...",
    });

    const retrievalResult = await retrievePassages({
      client: ctl.client,
      story,
      query: userPrompt,
      retrievalLimit,
      retrievalThreshold,
      abortSignal: ctl.abortSignal,
    });

    checkAbort(ctl.abortSignal);

    if (!retrievalResult.ok) {
      retrievalStatus.setState({
        status: retrievalResult.reason === "embedding-mismatch" ? "error" : "canceled",
        text: retrievalResult.message,
      });
      if (retrievalResult.logMessage) {
        console.error("[BigRAG-Stories]", retrievalResult.logMessage);
      }
      if (retrievalResult.reason === "embedding-mismatch") {
        return retrievalResult.message + `\n\nUser Query:\n\n${userPrompt}`;
      }
      // empty-index fallback (e.g. index cleared between stats check and search)
      const noteAboutEmptyIndex =
        `Important: The document index is empty (no chunks stored yet). ` +
        `In one short sentence, tell the user that nothing has been indexed. ` +
        `Then answer their question to the best of your ability without claiming document retrieval.`;
      return noteAboutEmptyIndex + `\n\nUser Query:\n\n${userPrompt}`;
    }

    const results = retrievalResult.passages;

    if (results.length > 0) {
      const docSummaries = results
        .map(
          (result, idx) =>
            `#${idx + 1} file=${path.basename(result.filePath)} shard=${result.shardName} score=${result.score.toFixed(3)}`,
        )
        .join("\n");
      console.info(`[BigRAG-Stories] Relevant documents:\n${docSummaries}`);
    }

    if (results.length === 0) {
      retrievalStatus.setState({
        status: "canceled",
        text: `No relevant content found in ${story.displayName}`,
      });

      const noteAboutNoResults =
        `Important: No relevant content was found in the indexed documents for the user query. ` +
        `In less than one sentence, inform the user of this. ` +
        `Then respond to the query to the best of your ability.`;

      return noteAboutNoResults + `\n\nUser Query:\n\n${userPrompt}`;
    }

    retrievalStatus.setState({
      status: "done",
      text: `Retrieved ${results.length} relevant passages from ${story.displayName}`,
    });

    ctl.debug("Retrieval results:", results);

    const { full: ragContextFull, preview: ragContextPreview } = formatRagContext(results);

    const promptTemplate = normalizePromptTemplate(chatConfig.get("promptTemplate") as string | undefined);
    const finalPrompt = fillPromptTemplate(promptTemplate, {
      [RAG_CONTEXT_MACRO]: ragContextFull,
      [USER_QUERY_MACRO]: userPrompt,
    });
    const finalPromptPreview = fillPromptTemplate(promptTemplate, {
      [RAG_CONTEXT_MACRO]: ragContextPreview,
      [USER_QUERY_MACRO]: userPrompt,
    });

    ctl.debug("Processed content (preview):", finalPromptPreview);

    const passagesLogEntries = results.map((result, idx) => {
      const fileName = path.basename(result.filePath);
      return `#${idx + 1} file=${fileName} shard=${result.shardName} score=${result.score.toFixed(3)}\n${summarizeText(result.text)}`;
    });
    const passagesLog = passagesLogEntries.join("\n\n");

    console.info(`[BigRAG-Stories] RAG passages (${results.length}) preview:\n${passagesLog}`);
    ctl.createStatus({
      status: "done",
      text: `RAG passages (${results.length}):`,
    });
    for (const entry of passagesLogEntries) {
      ctl.createStatus({
        status: "done",
        text: entry,
      });
    }

    console.info(`[BigRAG-Stories] Final prompt sent to model (preview):\n${finalPromptPreview}`);
    ctl.createStatus({
      status: "done",
      text: `Final prompt sent to model (preview):\n${finalPromptPreview}`,
    });

    await warnIfContextOverflow(ctl, finalPrompt);

    return finalPrompt;
  } catch (error) {
    // IMPORTANT: Re-throw abort errors so LM Studio can stop the preprocessor promptly.
    // Swallowing AbortError causes the "did not abort in time" warning.
    if (isAbortError(error)) {
      throw error;
    }
    console.error("[PromptPreprocessor] Preprocessing failed.", error);
    return userMessage;
  }
}

interface ConfigReindexOpts {
  ctl: PromptPreprocessorController;
  story: StoryHandle;
  maxConcurrent: number;
  parseDelayMs: number;
  reindexRequested: boolean;
  skipPreviouslyIndexed: boolean;
  /** Store opened for this story's indexDir; indexing must write only here. */
  vectorStore: VectorStore;
}

type StatusHandle = ReturnType<PromptPreprocessorController["createStatus"]>;

function reportProgress(status: StatusHandle, progress: IndexingProgress, embeddingModelId: string): void {
  if (progress.status === "scanning") {
    status.setState({
      status: "loading",
      text: `Scanning: ${progress.currentFile} (embedding model: ${embeddingModelId})`,
    });
  } else if (progress.status === "indexing") {
    const success = progress.successfulFiles ?? 0;
    const failed = progress.failedFiles ?? 0;
    const skipped = progress.skippedFiles ?? 0;
    status.setState({
      status: "loading",
      text: `Indexing: ${progress.processedFiles}/${progress.totalFiles} files ` +
        `(success=${success}, failed=${failed}, skipped=${skipped}) ` +
        `(embedding model: ${embeddingModelId}) ` +
        `(${progress.currentFile})`,
    });
  } else if (progress.status === "complete") {
    status.setState({
      status: "done",
      text: `Indexing complete: ${progress.processedFiles} files processed (embedding model: ${embeddingModelId})`,
    });
  } else if (progress.status === "error") {
    status.setState({
      status: "canceled",
      text: `Indexing error: ${progress.error}`,
    });
  }
}

async function maybeHandleConfigTriggeredReindex({
  ctl,
  story,
  maxConcurrent,
  parseDelayMs,
  reindexRequested,
  skipPreviouslyIndexed,
  vectorStore,
}: ConfigReindexOpts) {
  if (!reindexRequested) {
    return;
  }
  const embeddingModelId = story.embeddingModelId;

  const reminderText =
    `Manual Reindex Trigger is ON for ${story.displayName}. Skip Previously Indexed Files is currently ${skipPreviouslyIndexed ? "ON" : "OFF"}. ` +
    "The index will be rebuilt each chat when 'Skip Previously Indexed Files' is OFF. If 'Skip Previously Indexed Files' is ON, the index will only be rebuilt for new or changed files. " +
    `Embedding model for this run: ${embeddingModelId}.`;
  console.info(`[BigRAG-Stories] ${reminderText}`);
  ctl.createStatus({
    status: "done",
    text: reminderText,
  });

  if (!tryStartIndexing(story.indexDir, `config-trigger:${story.id}`)) {
    ctl.createStatus({
      status: "canceled",
      text: `Reindex of ${story.displayName} already running. Please wait for it to finish.`,
    });
    return;
  }

  const status = ctl.createStatus({
    status: "loading",
    text: `Manual reindex requested from config… (embedding model: ${embeddingModelId})`,
  });

  try {
    const { indexingResult } = await runIndexingJob({
      client: ctl.client,
      abortSignal: ctl.abortSignal,
      story,
      vectorStore,
      maxConcurrent,
      parseDelayMs,
      autoReindex: skipPreviouslyIndexed,
      forceReindex: !skipPreviouslyIndexed,
      onProgress: (progress) => reportProgress(status, progress, embeddingModelId),
    });

    status.setState({
      status: "done",
      text: `Manual reindex complete! (embedding model: ${embeddingModelId})`,
    });

    const summaryLines = [
      `Story: ${story.displayName}`,
      `Embedding model: ${embeddingModelId}`,
      `Processed: ${indexingResult.successfulFiles}/${indexingResult.totalFiles}`,
      `Failed: ${indexingResult.failedFiles}`,
      `Skipped (unchanged): ${indexingResult.skippedFiles}`,
      `Updated existing files: ${indexingResult.updatedFiles}`,
      `New files added: ${indexingResult.newFiles}`,
      `Pruned (no longer in sources): ${indexingResult.prunedFiles ?? 0}`,
    ];
    for (const line of summaryLines) {
      ctl.createStatus({
        status: "done",
        text: line,
      });
    }

    if (indexingResult.totalFiles > 0 && indexingResult.skippedFiles === indexingResult.totalFiles) {
      ctl.createStatus({
        status: "done",
        text: "All files were already up to date (skipped).",
      });
    }

    console.log(
      `[BigRAG-Stories] Manual reindex summary:\n  ${summaryLines.join("\n  ")}`,
    );

    await notifyManualResetNeeded(ctl, embeddingModelId);
  } catch (error) {
    status.setState({
      status: "error",
      text: `Manual reindex failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    console.error("[BigRAG-Stories] Manual reindex failed:", error);
  } finally {
    finishIndexing(story.indexDir);
  }
}

async function notifyManualResetNeeded(
  ctl: PromptPreprocessorController,
  embeddingModelId: string,
) {
  try {
    await ctl.client.system.notify({
      title: "Manual reindex completed",
      description:
        `Manual Reindex Trigger is ON. The index will be rebuilt each chat when 'Skip Previously Indexed Files' is OFF. If 'Skip Previously Indexed Files' is ON, the index will only be rebuilt for new or changed files. Last run used embedding model: ${embeddingModelId}.`,
    });
  } catch (error) {
    console.warn("[BigRAG-Stories] Unable to send notification about manual reindex reset:", error);
  }
}


