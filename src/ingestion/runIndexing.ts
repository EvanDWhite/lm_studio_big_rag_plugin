import { type LMStudioClient } from "@lmstudio/sdk";
import { IndexManager, type IndexingProgress, type IndexingResult } from "./indexManager";
import { VectorStore } from "../vectorstore/vectorStore";
import { syncEmbeddingManifestAfterIndexing, readEmbeddingIndexManifest } from "../utils/embeddingIndexManifest";
import { resolveAdditionalExtensions } from "../utils/additionalExtensions";
import { updateStoryAfterIndexing, type StoryHandle } from "../stories/storyRegistry";

export interface RunIndexingParams {
  client: LMStudioClient;
  abortSignal: AbortSignal;
  /** The one story DB this job may read and write. */
  story: StoryHandle;
  /**
   * Store instance opened for `story.indexDir` (from ensureVectorStore). If omitted, a private
   * instance is opened and closed for this job.
   */
  vectorStore?: VectorStore;
  maxConcurrent: number;
  parseDelayMs: number;
  autoReindex: boolean;
  forceReindex?: boolean;
  failureReportPath?: string;
  onProgress?: (progress: IndexingProgress) => void;
}

export interface RunIndexingResult {
  summary: string;
  stats: {
    totalChunks: number;
    uniqueFiles: number;
  };
  indexingResult: IndexingResult;
}

/**
 * Shared helper that runs the full indexing pipeline for exactly one story.
 * Used by config-triggered reindex, automatic first-run indexing and the CLI.
 */
export async function runIndexingJob({
  client,
  abortSignal,
  story,
  vectorStore: existingVectorStore,
  maxConcurrent,
  parseDelayMs,
  autoReindex,
  forceReindex = false,
  failureReportPath,
  onProgress,
}: RunIndexingParams): Promise<RunIndexingResult> {
  const vectorStore = existingVectorStore ?? new VectorStore(story.indexDir);
  const ownsVectorStore = existingVectorStore === undefined;

  if (ownsVectorStore) {
    await vectorStore.initialize();
  }

  const embeddingModel = await client.embedding.model(story.embeddingModelId, { signal: abortSignal });
  const { additionalPlainTextSet } = resolveAdditionalExtensions(
    story.additionalExtensions.join("\n"),
    (message) => console.warn(message),
  );

  const indexManager = new IndexManager({
    documentsDirs: story.sourceDirs,
    vectorStore,
    vectorStoreDir: story.indexDir,
    embeddingModel,
    client,
    chunkSize: story.chunkSize,
    chunkOverlap: story.chunkOverlap,
    maxConcurrent,
    enableOCR: story.enableOCR,
    autoReindex: forceReindex ? false : autoReindex,
    parseDelayMs,
    failureReportPath,
    excludePatterns: story.excludePatterns,
    additionalPlainTextExtensions: additionalPlainTextSet,
    abortSignal,
    onProgress,
    storyId: story.chunkStamp,
    failureRegistryPath: story.failureRegistryPath,
    pruneMissingFiles: story.pruneMissingFiles,
  });

  try {
    const indexingResult = await indexManager.index();
    const stats = await vectorStore.getStats();

    await syncEmbeddingManifestAfterIndexing(
      story.indexDir,
      stats.totalChunks,
      story.embeddingModelId,
      embeddingModel,
    );
    const manifest = await readEmbeddingIndexManifest(story.indexDir);
    await updateStoryAfterIndexing(story, {
      totalChunks: stats.totalChunks,
      uniqueFiles: stats.uniqueFiles,
      dimensions: manifest?.dimensions ?? null,
    });

    const summary = `Indexing completed for ${story.displayName}!\n\n` +
      `• Successfully indexed: ${indexingResult.successfulFiles}/${indexingResult.totalFiles}\n` +
      `• Failed: ${indexingResult.failedFiles}\n` +
      `• Skipped (unchanged): ${indexingResult.skippedFiles}\n` +
      `• Updated existing files: ${indexingResult.updatedFiles}\n` +
      `• New files added: ${indexingResult.newFiles}\n` +
      `• Pruned (no longer in sources): ${indexingResult.prunedFiles ?? 0}\n` +
      `• Chunks in store: ${stats.totalChunks}\n` +
      `• Unique files in store: ${stats.uniqueFiles}`;

    return { summary, stats, indexingResult };
  } finally {
    if (ownsVectorStore) {
      await vectorStore.close();
    }
  }
}
