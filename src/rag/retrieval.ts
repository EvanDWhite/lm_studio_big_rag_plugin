import * as path from "path";
import { type LMStudioClient } from "@lmstudio/sdk";
import { resolveEmbeddingModelId } from "../config";
import { VectorStore, type SearchResult } from "../vectorstore/vectorStore";
import { chunkBelongsToStory, type StoryHandle } from "../stories/storyRegistry";
import {
  checkEmbeddingModelForRetrieval,
  deleteEmbeddingIndexManifest,
} from "../utils/embeddingIndexManifest";

/**
 * Open vector stores keyed by resolved directory.
 *
 * Each chat / tool call must use the instance returned by `ensureVectorStore(dir)` for its own
 * directory. There is intentionally no "current store" accessor: a process-wide singleton let a
 * concurrent chat with a different vectorStoreDir swap (and close) the store out from under an
 * in-flight request, so one chat could index into another chat's store.
 */
const openVectorStores = new Map<string, VectorStore>();
/** Per-directory open promises so concurrent opens of the same dir share one initialization. */
const pendingVectorStoreOpens = new Map<string, Promise<VectorStore>>();

function throwIfAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted) {
    throw abortSignal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

async function openVectorStore(resolvedDir: string): Promise<VectorStore> {
  const nextStore = new VectorStore(resolvedDir);
  try {
    await nextStore.initialize();
    const statsAfterInit = await nextStore.getStats();
    if (statsAfterInit.totalChunks === 0) {
      await deleteEmbeddingIndexManifest(resolvedDir);
    }
  } catch (error: unknown) {
    try {
      await nextStore.close();
    } catch {
      // Ignore close errors after a failed open.
    }
    throw error;
  }
  console.info(`[BigRAG-Stories] Vector store ready (path=${resolvedDir}). Waiting for queries...`);
  return nextStore;
}

/**
 * Open or reuse the in-memory vector store for the given directory.
 * Stores for other directories are left open, so callers holding them are unaffected.
 */
export async function ensureVectorStore(vectorStoreDir: string): Promise<VectorStore> {
  const resolvedDir = path.resolve(vectorStoreDir);

  const existing = openVectorStores.get(resolvedDir);
  if (existing) {
    return existing;
  }

  let pending = pendingVectorStoreOpens.get(resolvedDir);
  if (!pending) {
    pending = openVectorStore(resolvedDir)
      .then((store) => {
        openVectorStores.set(resolvedDir, store);
        return store;
      })
      .finally(() => {
        pendingVectorStoreOpens.delete(resolvedDir);
      });
    pendingVectorStoreOpens.set(resolvedDir, pending);
  }
  return pending;
}

/** @internal Test helper: drop all cached stores (does not touch disk). */
export async function resetVectorStoreCacheForTest(): Promise<void> {
  const stores = Array.from(openVectorStores.values());
  openVectorStores.clear();
  pendingVectorStoreOpens.clear();
  for (const store of stores) {
    await store.close();
  }
}

export function summarizeText(text: string, maxLines: number = 3, maxChars: number = 400): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const clippedLines = lines.slice(0, maxLines);
  let clipped = clippedLines.join("\n");
  if (clipped.length > maxChars) {
    clipped = clipped.slice(0, maxChars);
  }
  const needsEllipsis =
    lines.length > maxLines ||
    text.length > clipped.length ||
    (clipped.length === maxChars && text.length > maxChars);
  return needsEllipsis ? `${clipped.trimEnd()}…` : clipped;
}

export interface RetrievedPassage {
  text: string;
  score: number;
  filePath: string;
  fileName: string;
  chunkIndex: number;
  shardName: string;
  metadata: Record<string, unknown>;
}

export interface RagContextBlocks {
  full: string;
  preview: string;
}

export function formatRagContext(passages: RetrievedPassage[]): RagContextBlocks {
  let ragContextFull = "";
  let ragContextPreview = "";
  const prefix = "The following passages were found in your indexed documents:\n\n";
  ragContextFull += prefix;
  ragContextPreview += prefix;

  let citationNumber = 1;
  for (const passage of passages) {
    // Story chunks store paths relative to the title folder: show them ("characters/hero.md").
    const fileName = path.isAbsolute(passage.filePath) || passage.filePath === ""
      ? path.basename(passage.filePath)
      : passage.filePath;
    const citationLabel =
      `Citation ${citationNumber} (from ${fileName}, score: ${passage.score.toFixed(3)}): `;
    ragContextFull += `\n${citationLabel}"${passage.text}"\n\n`;
    ragContextPreview += `\n${citationLabel}"${summarizeText(passage.text)}"\n\n`;
    citationNumber++;
  }

  return {
    full: ragContextFull.trimEnd(),
    preview: ragContextPreview.trimEnd(),
  };
}

function mapSearchResults(results: SearchResult[]): RetrievedPassage[] {
  return results.map((result) => ({
    text: result.text,
    score: result.score,
    filePath: result.filePath,
    fileName: result.fileName,
    chunkIndex: result.chunkIndex,
    shardName: result.shardName,
    metadata: result.metadata,
  }));
}

export interface RetrievePassagesParams {
  client: LMStudioClient;
  /** The one story DB to search. Embedding model and index location come from it. */
  story: StoryHandle;
  query: string;
  retrievalLimit: number;
  retrievalThreshold: number;
  abortSignal?: AbortSignal;
}

export type RetrievePassagesResult =
  | { ok: true; passages: RetrievedPassage[] }
  | {
      ok: false;
      reason: "empty-index" | "embedding-mismatch";
      message: string;
      logMessage?: string;
    };

export async function retrievePassages(
  params: RetrievePassagesParams,
): Promise<RetrievePassagesResult> {
  const { client, story, query, retrievalLimit, retrievalThreshold, abortSignal } = params;

  const resolvedModelId = resolveEmbeddingModelId(story.embeddingModelId);
  const resolvedStoreDir = path.resolve(story.indexDir);
  throwIfAborted(abortSignal);

  const store = await ensureVectorStore(resolvedStoreDir);
  const stats = await store.getStats();

  if (stats.totalChunks === 0) {
    await deleteEmbeddingIndexManifest(resolvedStoreDir);
    return {
      ok: false,
      reason: "empty-index",
      message: "The document index is empty (no chunks stored yet).",
    };
  }

  const embeddingModel = await client.embedding.model(resolvedModelId, {
    signal: abortSignal,
  });

  throwIfAborted(abortSignal);

  const compatibility = await checkEmbeddingModelForRetrieval({
    vectorStoreDir: resolvedStoreDir,
    resolvedModelId,
    totalChunks: stats.totalChunks,
    embeddingModel,
  });

  if (!compatibility.ok) {
    return {
      ok: false,
      reason: "embedding-mismatch",
      message: compatibility.userMessage,
      logMessage: compatibility.logMessage,
    };
  }

  const queryPreview = query.length > 160 ? `${query.slice(0, 160)}...` : query;
  console.info(
    `[BigRAG-Stories] Executing vector search for "${queryPreview}" (limit=${retrievalLimit}, threshold=${retrievalThreshold})`,
  );

  const queryEmbeddingResult = await embeddingModel.embed(query);
  throwIfAborted(abortSignal);

  // Ownership filter: only chunks stamped for this story (or unstamped, for legacy stores).
  const results = await store.search(
    queryEmbeddingResult.embedding,
    retrievalLimit,
    retrievalThreshold,
    (metadata) => chunkBelongsToStory(metadata, story),
  );

  if (results.length > 0) {
    const topHit = results[0];
    console.info(
      `[BigRAG-Stories] Vector search returned ${results.length} results. Top hit: file=${topHit.fileName} score=${topHit.score.toFixed(3)}`,
    );
  } else {
    console.warn("[BigRAG-Stories] Vector search returned 0 results.");
  }

  return { ok: true, passages: mapSearchResults(results) };
}

export interface IndexStatusParams {
  story: StoryHandle;
}

export interface IndexStatusResult {
  storyId: string;
  storyName: string;
  kind: StoryHandle["kind"];
  sourceDirs: string[];
  excludePatterns: string[];
  indexDir: string;
  embeddingModelId: string;
  totalChunks: number;
  uniqueFiles: number;
}

export async function getIndexStatus(params: IndexStatusParams): Promise<IndexStatusResult> {
  const { story } = params;
  const store = await ensureVectorStore(story.indexDir);
  const stats = await store.getStats();

  return {
    storyId: story.id,
    storyName: story.displayName,
    kind: story.kind,
    sourceDirs: story.sourceDirs,
    excludePatterns: story.excludePatterns,
    indexDir: story.indexDir,
    embeddingModelId: resolveEmbeddingModelId(story.embeddingModelId),
    totalChunks: stats.totalChunks,
    uniqueFiles: stats.uniqueFiles,
  };
}
