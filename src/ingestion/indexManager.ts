import PQueue from "p-queue";
import * as fs from "fs";
import * as path from "path";
import { scanDirectory, type ScannedFile, type ExcludedFileInfo } from "./fileScanner";
import { parseDocument, type ParseFailureReason } from "../parsers/documentParser";
import { VectorStore, type DocumentChunk } from "../vectorstore/vectorStore";
import { chunkText } from "../utils/textChunker";
import { calculateFileHash } from "../utils/fileHash";
import { type EmbeddingDynamicHandle, type LMStudioClient } from "@lmstudio/sdk";
import { FailedFileRegistry } from "../utils/failedFileRegistry";
import { coerceEmbeddingVector } from "../utils/coerceEmbedding";
import { subfolderOf, toAbsolutePath, toStoredPath } from "../stories/storyPaths";

const EXCLUDE_PROGRESS_THROTTLE = 40;

export interface IndexingProgress {
  totalFiles: number;
  processedFiles: number;
  currentFile: string;
  status: "scanning" | "indexing" | "complete" | "error";
  successfulFiles?: number;
  failedFiles?: number;
  skippedFiles?: number;
  error?: string;
}

export interface IndexingResult {
  totalFiles: number;
  successfulFiles: number;
  failedFiles: number;
  skippedFiles: number;
  updatedFiles: number;
  newFiles: number;
  /** Files whose chunks were removed because they are no longer under the source dirs. */
  prunedFiles?: number;
}

type FileIndexOutcome =
  | { type: "skipped" }
  | { type: "indexed"; changeType: "new" | "updated" }
  | { type: "failed" };

export interface IndexingOptions {
  documentsDirs: string[];
  vectorStore: VectorStore;
  vectorStoreDir: string;
  embeddingModel: EmbeddingDynamicHandle;
  client: LMStudioClient;
  chunkSize: number;
  chunkOverlap: number;
  maxConcurrent: number;
  enableOCR: boolean;
  autoReindex: boolean;
  parseDelayMs: number;
  failureReportPath?: string;
  /** Glob patterns (relative to documents dir); matched supported files are skipped before parsing. */
  excludePatterns?: string[];
  /** User-declared plain-text extensions (e.g. .java) merged into the scan gate and parse path. */
  additionalPlainTextExtensions?: ReadonlySet<string>;
  abortSignal?: AbortSignal;
  onProgress?: (progress: IndexingProgress) => void;
  /** Story id stamped into every chunk (`metadata.storyId`) and chunk id. Omit for legacy stores. */
  storyId?: string;
  /** Failure registry location; defaults to `<vectorStoreDir>/.big-rag-failures.json`. */
  failureRegistryPath?: string;
  /** Delete chunks for files that are no longer found under the source dirs (or now excluded). */
  pruneMissingFiles?: boolean;
  /** Store chunk paths relative to this folder (story title folder). Omit = absolute paths. */
  pathBase?: string;
  /** Skip pruning (with a warning) when more than this fraction of indexed files would go. Default 1 (off). */
  maxPruneFraction?: number;
}

type FailureReason = ParseFailureReason | "index.chunk-empty" | "index.vector-add-error";

export class IndexManager {
  private queue: PQueue;
  private options: IndexingOptions;
  private failureReasonCounts: Record<string, number> = {};
  private failedFileRegistry: FailedFileRegistry;

  constructor(options: IndexingOptions) {
    this.options = options;
    this.queue = new PQueue({ concurrency: options.maxConcurrent });
    this.failedFileRegistry = new FailedFileRegistry(
      options.failureRegistryPath ?? path.join(options.vectorStoreDir, ".big-rag-failures.json"),
    );
  }

  /**
   * Start the indexing process
   */
  async index(): Promise<IndexingResult> {
    const { documentsDirs, vectorStore, onProgress } = this.options;

    try {
      // Inventory keyed by ABSOLUTE path (stored paths may be relative to pathBase);
      // storedKeys remembers the stored form(s) for deletes.
      const storedInventory = await vectorStore.getFileHashInventory();
      const fileInventory = new Map<string, Set<string>>();
      const storedKeys = new Map<string, string[]>();
      for (const [storedPath, hashes] of storedInventory) {
        const absolute = toAbsolutePath(storedPath, this.options.pathBase);
        const merged = fileInventory.get(absolute) ?? new Set<string>();
        hashes.forEach((h) => merged.add(h));
        fileInventory.set(absolute, merged);
        storedKeys.set(absolute, [...(storedKeys.get(absolute) ?? []), storedPath]);
      }

      // Step 1: Scan directory
      if (onProgress) {
        onProgress({
          totalFiles: 0,
          processedFiles: 0,
          currentFile: "",
          status: "scanning",
        });
      }

      const excludePatterns = this.options.excludePatterns ?? [];
      let excludedByPattern = 0;
      let lastExcludeProgressEmittedAt = 0;
      let lastExcludedRelative = "";

      const onExcludedFile: ((info: ExcludedFileInfo) => void) | undefined =
        excludePatterns.length > 0
          ? (info: ExcludedFileInfo) => {
              excludedByPattern++;
              lastExcludedRelative = info.relativePath;
              console.log(
                `Excluded from indexing (exclude pattern): ${info.relativePath} (matched: ${info.pattern})`,
              );
              if (!onProgress) {
                return;
              }
              if (
                excludedByPattern === 1 ||
                excludedByPattern - lastExcludeProgressEmittedAt >= EXCLUDE_PROGRESS_THROTTLE
              ) {
                lastExcludeProgressEmittedAt = excludedByPattern;
                onProgress({
                  totalFiles: 0,
                  processedFiles: 0,
                  currentFile: `Excluded ${excludedByPattern} by pattern (latest: ${lastExcludedRelative})`,
                  status: "scanning",
                });
              }
            }
          : undefined;

      const files = await scanDirectory(
        documentsDirs,
        (scanned, found) => {
          if (onProgress) {
            onProgress({
              totalFiles: found,
              processedFiles: 0,
              currentFile: `Scanned ${scanned} files...`,
              status: "scanning",
            });
          }
        },
        {
          excludePatterns,
          additionalPlainTextExtensions: this.options.additionalPlainTextExtensions,
          onExcludedFile,
        },
      );

      if (
        onProgress &&
        excludedByPattern > 0 &&
        excludedByPattern !== lastExcludeProgressEmittedAt
      ) {
        onProgress({
          totalFiles: 0,
          processedFiles: 0,
          currentFile: `Excluded ${excludedByPattern} by pattern (latest: ${lastExcludedRelative})`,
          status: "scanning",
        });
      }

      this.options.abortSignal?.throwIfAborted();

      console.log(
        `Found ${files.length} files to process` +
          (excludedByPattern > 0
            ? ` (${excludedByPattern} excluded by exclude patterns)`
            : ""),
      );

      const prunedCount = await this.pruneMissingFiles(files, fileInventory, storedKeys, onProgress);

      // Step 2: Index files
      let processedCount = 0;
      let successCount = 0;
      let failCount = 0;
      let skippedCount = 0;
      let updatedCount = 0;
      let newCount = 0;

      if (onProgress) {
        onProgress({
          totalFiles: files.length,
          processedFiles: 0,
          currentFile: files[0]?.name ?? "",
          status: "indexing",
        });
      }

      // Abort listener: when signal fires, clear pending tasks from the queue
      const abortSignal = this.options.abortSignal;
      const onAbort = () => this.queue.clear();
      if (abortSignal) {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      // Process files in batches
      const tasks = files.map((file) =>
        this.queue.add(async () => {
          // Check abort before processing each file
          abortSignal?.throwIfAborted();

          let outcome: FileIndexOutcome = { type: "failed" };
          try {
            if (onProgress) {
              onProgress({
                totalFiles: files.length,
                processedFiles: processedCount,
                currentFile: file.name,
                status: "indexing",
                successfulFiles: successCount,
                failedFiles: failCount,
                skippedFiles: skippedCount,
              });
            }

            outcome = await this.indexFile(file, fileInventory);
          } catch (error) {
            console.error(`Error indexing file ${file.path}:`, error);
            this.recordFailure(
              "parser.unexpected-error",
              error instanceof Error ? error.message : String(error),
              file,
            );
          }

          processedCount++;
          switch (outcome.type) {
            case "skipped":
              successCount++;
              skippedCount++;
              break;
            case "indexed":
              successCount++;
              if (outcome.changeType === "new") {
                newCount++;
              } else {
                updatedCount++;
              }
              break;
            case "failed":
              failCount++;
              break;
          }

          if (onProgress) {
            onProgress({
              totalFiles: files.length,
              processedFiles: processedCount,
              currentFile: file.name,
              status: "indexing",
              successfulFiles: successCount,
              failedFiles: failCount,
              skippedFiles: skippedCount,
            });
          }
        })
      );

      await Promise.all(tasks);

      // Clean up abort listener
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }

      if (onProgress) {
        onProgress({
          totalFiles: files.length,
          processedFiles: processedCount,
          currentFile: "",
          status: "complete",
          successfulFiles: successCount,
          failedFiles: failCount,
          skippedFiles: skippedCount,
        });
      }

      this.logFailureSummary();
      await this.writeFailureReport({
        totalFiles: files.length,
        successfulFiles: successCount,
        failedFiles: failCount,
        skippedFiles: skippedCount,
        updatedFiles: updatedCount,
        newFiles: newCount,
        prunedFiles: prunedCount,
      });

      console.log(
        `Indexing complete: ${successCount}/${files.length} files successfully indexed (${failCount} failed, skipped=${skippedCount}, updated=${updatedCount}, new=${newCount})` +
          (excludedByPattern > 0 ? `; excluded by pattern=${excludedByPattern}` : ""),
      );
      
      return {
        totalFiles: files.length,
        successfulFiles: successCount,
        failedFiles: failCount,
        skippedFiles: skippedCount,
        updatedFiles: updatedCount,
        newFiles: newCount,
        prunedFiles: prunedCount,
      };
    } catch (error) {
      console.error("Error during indexing:", error);
      if (onProgress) {
        onProgress({
          totalFiles: 0,
          processedFiles: 0,
          currentFile: "",
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  /**
   * Index a single file
   */
  private async indexFile(
    file: ScannedFile,
    fileInventory: Map<string, Set<string>> = new Map(),
  ): Promise<FileIndexOutcome> {
    const { vectorStore, embeddingModel, client, chunkSize, chunkOverlap, enableOCR, autoReindex } =
      this.options;

    const storedPath = toStoredPath(file.path, this.options.pathBase);
    let fileHash: string | undefined;
    try {
      // Calculate file hash
      fileHash = await calculateFileHash(file.path);
      const existingHashes = fileInventory.get(path.resolve(file.path));
      const hasSeenBefore = existingHashes !== undefined && existingHashes.size > 0;
      const hasSameHash = existingHashes?.has(fileHash) ?? false;

      // Check if file already indexed
      if (autoReindex && hasSameHash) {
        console.log(`File already indexed (skipped): ${file.name}`);
        return { type: "skipped" };
      }

      if (autoReindex) {
        const previousFailure = await this.failedFileRegistry.getFailureReason(file.path, fileHash);
        if (previousFailure) {
          console.log(
            `File previously failed (skipped): ${file.name} (reason=${previousFailure})`,
          );
          return { type: "skipped" };
        }
      }

      // Wait before parsing to reduce WebSocket load
      if (this.options.parseDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.options.parseDelayMs));
      }

      // Parse document
      const parsedResult = await parseDocument(
        file.path,
        enableOCR,
        client,
        this.options.additionalPlainTextExtensions ?? new Set<string>(),
      );
      if (!parsedResult.success) {
        this.recordFailure(parsedResult.reason, parsedResult.details, file);
        if (fileHash) {
          await this.failedFileRegistry.recordFailure(file.path, fileHash, parsedResult.reason);
        }
        return { type: "failed" };
      }
      const parsed = parsedResult.document;

      // Chunk text
      const chunks = chunkText(parsed.text, chunkSize, chunkOverlap);
      if (chunks.length === 0) {
        console.log(`No chunks created from ${file.name}`);
        this.recordFailure("index.chunk-empty", "chunkText produced 0 chunks", file);
        if (fileHash) {
          await this.failedFileRegistry.recordFailure(file.path, fileHash, "index.chunk-empty");
        }
        return { type: "failed" }; // Failed to chunk
      }

      // Generate embeddings and create document chunks
      const documentChunks: DocumentChunk[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        
        // Check abort between chunk embeddings
        this.options.abortSignal?.throwIfAborted();

        try {
          // Generate embedding
          const embeddingResult = await embeddingModel.embed(chunk.text);
          const embedding = coerceEmbeddingVector(embeddingResult.embedding);
          
          const storyId = this.options.storyId;
          const subfolder = subfolderOf(storedPath);
          documentChunks.push({
            id: storyId ? `${storyId}:${fileHash}-${i}` : `${fileHash}-${i}`,
            text: chunk.text,
            vector: embedding,
            filePath: storedPath,
            fileName: file.name,
            fileHash,
            chunkIndex: i,
            metadata: {
              extension: file.extension,
              size: file.size,
              mtime: file.mtime.toISOString(),
              startIndex: chunk.startIndex,
              endIndex: chunk.endIndex,
              ...(storyId ? { storyId } : {}),
              ...(subfolder ? { subfolder } : {}),
            },
          });
        } catch (error) {
          console.error(`Error embedding chunk ${i} of ${file.name}:`, error);
        }
      }

      // Add chunks to vector store
      if (documentChunks.length === 0) {
        this.recordFailure(
          "index.chunk-empty",
          "All chunk embeddings failed, no document chunks",
          file,
        );
        if (fileHash) {
          await this.failedFileRegistry.recordFailure(file.path, fileHash, "index.chunk-empty");
        }
        return { type: "failed" };
      }

      try {
        // Upsert new chunks first, then drop other hashes for this path.
        // Deleting first would wipe the prior index if addChunks failed.
        await vectorStore.addChunks(documentChunks);
        await vectorStore.deleteOrphanChunksForFilePath(
          storedPath,
          fileHash,
          new Set(documentChunks.map((c) => c.id)),
        );
        console.log(`Indexed ${documentChunks.length} chunks from ${file.name}`);
        fileInventory.set(path.resolve(file.path), new Set([fileHash]));
        await this.failedFileRegistry.clearFailure(file.path);
        return {
          type: "indexed",
          changeType: hasSeenBefore ? "updated" : "new",
        };
      } catch (error) {
        console.error(`Error adding chunks for ${file.name}:`, error);
        this.recordFailure(
          "index.vector-add-error",
          error instanceof Error ? error.message : String(error),
          file,
        );
        if (fileHash) {
          await this.failedFileRegistry.recordFailure(file.path, fileHash, "index.vector-add-error");
        }
        return { type: "failed" };
      }
    } catch (error) {
          console.error(`Error indexing file ${file.path}:`, error);
          this.recordFailure(
            "parser.unexpected-error",
            error instanceof Error ? error.message : String(error),
            file,
          );
      if (fileHash) {
        await this.failedFileRegistry.recordFailure(file.path, fileHash, "parser.unexpected-error");
      }
      return { type: "failed" }; // Failed
    }
  }

  /**
   * Remove chunks for files that the scan no longer returns (deleted, moved, or now excluded).
   * Skipped when any source root is missing or the scan found nothing, so an unmounted drive
   * cannot wipe an index.
   */
  private async pruneMissingFiles(
    files: ScannedFile[],
    fileInventory: Map<string, Set<string>>,
    storedKeys: Map<string, string[]>,
    onProgress?: (progress: IndexingProgress) => void,
  ): Promise<number> {
    if (!this.options.pruneMissingFiles || fileInventory.size === 0) {
      return 0;
    }
    const missingRoot = this.options.documentsDirs.find((dir) => !fs.existsSync(dir));
    if (missingRoot !== undefined || files.length === 0) {
      console.warn(
        `[BigRAG-Stories] Skipping prune (${missingRoot ? `source folder missing: ${missingRoot}` : "scan found no files"}).`,
      );
      return 0;
    }
    const scanned = new Set(files.map((f) => path.resolve(f.path)));
    const missing = Array.from(fileInventory.keys()).filter((p) => !scanned.has(p));
    if (missing.length === 0) {
      return 0;
    }
    const maxFraction = this.options.maxPruneFraction ?? 1;
    const shown = missing.slice(0, 5).map((p) => toStoredPath(p, this.options.pathBase)).join(", ");
    if (fileInventory.size >= 4 && missing.length > maxFraction * fileInventory.size) {
      const message =
        `⚠ NOT pruning: ${missing.length} of ${fileInventory.size} indexed files are no longer in the sources ` +
        `(e.g. ${shown}). That looks like a wrong or missing folder; fix it, or remove the chunks deliberately.`;
      console.warn(`[BigRAG-Stories] ${message}`);
      onProgress?.({ totalFiles: 0, processedFiles: 0, currentFile: message, status: "scanning" });
      return 0;
    }
    onProgress?.({
      totalFiles: 0,
      processedFiles: 0,
      currentFile: `⚠ Pruning ${missing.length} file(s) no longer in sources: ${shown}${missing.length > 5 ? ", …" : ""}`,
      status: "scanning",
    });
    let pruned = 0;
    for (const absolutePath of missing) {
      {
        for (const storedPath of storedKeys.get(absolutePath) ?? [absolutePath]) {
          await this.options.vectorStore.deleteByFilePath(storedPath);
        }
        fileInventory.delete(absolutePath);
        pruned++;
        console.log(`[BigRAG-Stories] Pruned chunks for file no longer in sources: ${absolutePath}`);
      }
    }
    return pruned;
  }

  /**
   * Reindex a specific file (delete old chunks and reindex)
   */
  async reindexFile(filePath: string): Promise<void> {
    try {
      // indexFile upserts the current hash then drops orphan hashes for this path.
      const fileName: string = filePath.split("/").pop() || filePath;
      const extensionPart: string = fileName.includes(".")
        ? fileName.slice(fileName.lastIndexOf("."))
        : "";
      const file: ScannedFile = {
        path: filePath,
        name: fileName,
        extension: extensionPart,
        mimeType: false,
        size: 0,
        mtime: new Date(),
      };

      await this.indexFile(file);
    } catch (error) {
      console.error(`Error reindexing file ${filePath}:`, error);
      throw error;
    }
  }

  private recordFailure(reason: FailureReason, details: string | undefined, file: ScannedFile) {
    const current = this.failureReasonCounts[reason] ?? 0;
    this.failureReasonCounts[reason] = current + 1;
    const detailSuffix = details ? ` details=${details}` : "";
    console.warn(
      `[BigRAG-Stories] Failed to parse ${file.name} (reason=${reason}, count=${this.failureReasonCounts[reason]})${detailSuffix}`,
    );
  }

  private logFailureSummary() {
    const entries = Object.entries(this.failureReasonCounts);
    if (entries.length === 0) {
      console.log("[BigRAG-Stories] No parsing failures recorded.");
      return;
    }
    console.log("[BigRAG-Stories] Failure reason summary:");
    for (const [reason, count] of entries) {
      console.log(`  - ${reason}: ${count}`);
    }
  }

  private async writeFailureReport(summary: IndexingResult) {
    const reportPath = this.options.failureReportPath;
    if (!reportPath) {
      return;
    }

    const payload = {
      ...summary,
      documentPaths: this.options.documentsDirs,
      failureReasons: this.failureReasonCounts,
      generatedAt: new Date().toISOString(),
    };

    try {
      await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.promises.writeFile(reportPath, JSON.stringify(payload, null, 2), "utf-8");
      console.log(`[BigRAG-Stories] Wrote failure report to ${reportPath}`);
    } catch (error) {
      console.error(`[BigRAG-Stories] Failed to write failure report to ${reportPath}:`, error);
    }
  }
}

