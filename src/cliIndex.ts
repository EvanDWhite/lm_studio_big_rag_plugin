import { LMStudioClient } from "@lmstudio/sdk";
import { runIndexingJob } from "./ingestion/runIndexing";
import { resolveEmbeddingModelId } from "./config";
import { parseExcludePatternsFromEnv } from "./utils/fileExcludePatterns";
import { parseAdditionalExtensionsFromEnv, resolveAdditionalExtensions } from "./utils/additionalExtensions";
import { parseDocumentPathsFromEnv } from "./utils/documentPaths";
import {
  createStory,
  legacyStoryHandle,
  listStories,
  loadStory,
  resolveStoriesRoot,
  type StoryHandle,
} from "./stories/storyRegistry";
import { type IndexingProgress } from "./ingestion/indexManager";
import { AdoptStoreError, adoptLegacyStore, formatAdoptReport, parsePathMap } from "./stories/adoptStore";

const USAGE = `Big RAG CLI

Stories (one isolated database per title folder):
  node dist/cliIndex.js create-story <titleDir> [--id <id>] [--name <displayName>] [--model <embeddingModel>]
        [--exclude <glob>]... [--chunk-size N] [--chunk-overlap N] [--index-dir <path> --accept-unstamped]
        (default: index every subfolder of <titleDir> except **/chapter_raw/**)
  node dist/cliIndex.js adopt-store --store <oldVectorStoreDir> <titleDir> [--dry-run] [--id <id>] [--name <displayName>]
        [--model <embeddingModel>] [--chunk-size N --chunk-overlap N] [--exclude <glob>]...
        [--path-map <OLD=NEW>]... [--no-auto-map] [--prune] [--move]
        Adopts an existing (pre-story) store as a new story WITHOUT re-embedding. Copies by default;
        the original store is only touched with --move. Run with --dry-run first.
  node dist/cliIndex.js list-stories
  node dist/cliIndex.js index --story <id> [--force]

  Stories root: --stories-root <dir>, else $BIG_RAG_STORIES_ROOT, else ~/.lmstudio/big-rag-stories

Legacy single store:
  BIG_RAG_DOCS_DIR=/path/to/docs BIG_RAG_DB_DIR=/path/to/db node dist/cliIndex.js
  node dist/cliIndex.js /path/to/docs /path/to/db
`;

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(["force", "accept-unstamped", "help", "dry-run", "move", "prune", "no-auto-map"]);

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const value = BOOLEAN_FLAGS.has(name) ? "true" : argv[++i];
      if (value === undefined) throw new Error(`Missing value for --${name}`);
      flags.set(name, [...(flags.get(name) ?? []), value]);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

function numFlag(args: ParsedArgs, name: string): number | undefined {
  const v = flag(args, name);
  return v === undefined ? undefined : Number(v);
}

function createClient(): LMStudioClient {
  const token = process.env.LM_API_TOKEN?.trim();
  if (!token) return new LMStudioClient();
  const match = /^sk-lm-([A-Za-z0-9]{8}):([A-Za-z0-9]{20})$/.exec(token);
  if (!match) {
    throw new Error("LM_API_TOKEN is not a valid LM Studio token (sk-lm-xxxxxxxx:yyyyyyyyyyyyyyyyyyyy)");
  }
  return new LMStudioClient({ clientIdentifier: match[1], clientPasskey: match[2] });
}

function logProgress(progress: IndexingProgress): void {
  if (progress.status === "scanning") {
    console.log(`[BigRAG CLI] Scanning: ${progress.currentFile || "discovering files"}`);
  } else if (progress.status === "indexing") {
    console.log(
      `[BigRAG CLI] Indexing: ${progress.processedFiles}/${progress.totalFiles} files ` +
        `(success=${progress.successfulFiles ?? 0}, failed=${progress.failedFiles ?? 0}, skipped=${progress.skippedFiles ?? 0})`,
    );
  } else if (progress.status === "complete") {
    console.log(`[BigRAG CLI] Indexing complete: ${progress.processedFiles} files processed`);
  } else if (progress.status === "error") {
    console.error(`[BigRAG CLI] Indexing error: ${progress.error}`);
  }
}

async function runIndex(story: StoryHandle, force: boolean): Promise<void> {
  console.log(`[BigRAG CLI] Target: ${story.displayName} (${story.id})`);
  console.log(`[BigRAG CLI] Source folder(s): ${story.sourceDirs.join(", ")}`);
  console.log(`[BigRAG CLI] Index dir: ${story.indexDir}`);
  console.log(`[BigRAG CLI] Embedding model: ${story.embeddingModelId}`);
  if (story.excludePatterns.length > 0) {
    console.log(`[BigRAG CLI] Exclude patterns: ${story.excludePatterns.join(", ")}`);
  }
  const maxConcurrent = Number(process.env.BIG_RAG_MAX_CONCURRENT ?? 1);
  const parseDelayMs = Number(process.env.BIG_RAG_PARSE_DELAY_MS ?? 500);
  const { summary } = await runIndexingJob({
    client: createClient(),
    abortSignal: new AbortController().signal,
    story,
    maxConcurrent,
    parseDelayMs,
    autoReindex: !force,
    forceReindex: force,
    failureReportPath: process.env.BIG_RAG_FAILURE_REPORT_PATH,
    onProgress: logProgress,
  });
  console.log(`[BigRAG CLI] ${summary}`);
}

function legacyFromEnv(argv: string[]): StoryHandle | null {
  const documentsDirs = parseDocumentPathsFromEnv(process.env.BIG_RAG_DOCS_DIR ?? argv[0]);
  const vectorStoreDir = process.env.BIG_RAG_DB_DIR ?? argv[1];
  if (documentsDirs.length === 0 || !vectorStoreDir) return null;
  const { additionalPlainTextSet } = resolveAdditionalExtensions(
    parseAdditionalExtensionsFromEnv(process.env.BIG_RAG_ADDITIONAL_EXTENSIONS).join("\n"),
    (message) => console.warn(message),
  );
  return legacyStoryHandle({
    documentsDirs,
    vectorStoreDir,
    embeddingModelId: resolveEmbeddingModelId(process.env.BIG_RAG_EMBEDDING_MODEL),
    chunkSize: process.env.BIG_RAG_CHUNK_SIZE ? Number(process.env.BIG_RAG_CHUNK_SIZE) : 512,
    chunkOverlap: process.env.BIG_RAG_CHUNK_OVERLAP ? Number(process.env.BIG_RAG_CHUNK_OVERLAP) : 100,
    enableOCR: (process.env.BIG_RAG_ENABLE_OCR ?? "true").toLowerCase() === "true",
    excludePatterns: parseExcludePatternsFromEnv(process.env.BIG_RAG_EXCLUDE_PATTERNS),
    additionalExtensions: Array.from(additionalPlainTextSet),
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  const storiesRoot = resolveStoriesRoot(flag(args, "stories-root"));

  if (command === "--help" || command === "help") {
    console.log(USAGE);
    return;
  }

  if (command === "create-story") {
    const titleDir = args.positional[0];
    if (!titleDir) throw new Error(`create-story needs <titleDir>\n\n${USAGE}`);
    const story = await createStory(storiesRoot, {
      id: flag(args, "id"),
      displayName: flag(args, "name"),
      titleDir,
      excludePatterns: args.flags.get("exclude"),
      embeddingModelId: flag(args, "model"),
      chunkSize: numFlag(args, "chunk-size"),
      chunkOverlap: numFlag(args, "chunk-overlap"),
      indexDir: flag(args, "index-dir"),
      acceptUnstampedChunks: flag(args, "accept-unstamped") === "true",
    });
    console.log(`[BigRAG CLI] Created story "${story.id}" at ${story.manifestPath}`);
    console.log(`[BigRAG CLI] Set "Story ID" to ${story.id} in a chat's Big RAG settings to use it.`);
    return;
  }

  if (command === "adopt-store") {
    const storeDir = flag(args, "store");
    const titleDir = args.positional[0];
    if (!storeDir || !titleDir) throw new Error(`adopt-store needs --store <oldVectorStoreDir> and <titleDir>\n\n${USAGE}`);
    const dryRun = flag(args, "dry-run") === "true";
    try {
      const report = await adoptLegacyStore({
        storeDir,
        titleDir,
        storiesRoot,
        id: flag(args, "id"),
        displayName: flag(args, "name"),
        embeddingModelId: flag(args, "model"),
        chunkSize: numFlag(args, "chunk-size"),
        chunkOverlap: numFlag(args, "chunk-overlap"),
        excludePatterns: args.flags.get("exclude"),
        pathMaps: (args.flags.get("path-map") ?? []).map(parsePathMap),
        autoPathMap: flag(args, "no-auto-map") !== "true",
        mode: flag(args, "move") === "true" ? "move" : "copy",
        prune: flag(args, "prune") === "true",
        dryRun,
      });
      console.log(formatAdoptReport(report));
      if (dryRun) {
        console.log(
          report.errors.length > 0
            ? "\nDry run: the real run would REFUSE (see above). Nothing was written."
            : "\nDry run OK. Nothing was written. Rerun without --dry-run to adopt.",
        );
        if (report.errors.length > 0) process.exitCode = 2;
      } else {
        console.log(`\nAdopted ${report.chunksAdopted} chunks into story "${report.storyId}" (${report.storyDir}).`);
        console.log(`Pick "${report.displayName}" in a chat's Big RAG "Story" dropdown (restart the plugin to refresh it) or type Story ID ${report.storyId}.`);
      }
    } catch (e) {
      if (e instanceof AdoptStoreError) {
        console.error(`[BigRAG CLI] adopt-store: ${e.message}`);
        process.exitCode = 2;
        return;
      }
      throw e;
    }
    return;
  }

  if (command === "list-stories") {
    const stories = await listStories(storiesRoot);
    console.log(`[BigRAG CLI] Stories root: ${storiesRoot}`);
    for (const s of stories) {
      console.log(`  ${s.id}\t${s.displayName}\t${s.sourceDirs.join(", ")}`);
    }
    if (stories.length === 0) console.log("  (none)");
    return;
  }

  if (command === "index") {
    const id = flag(args, "story");
    if (!id) throw new Error(`index needs --story <id>\n\n${USAGE}`);
    const loaded = await loadStory(storiesRoot, id);
    if (!loaded.ok) throw new Error(loaded.message);
    await runIndex(loaded.story, flag(args, "force") === "true");
    return;
  }

  const legacy = legacyFromEnv(argv);
  if (!legacy) {
    console.error(USAGE);
    process.exit(1);
  }
  await runIndex(legacy, (process.env.BIG_RAG_FORCE_REINDEX ?? "false").toLowerCase() === "true");
}

main().catch((error) => {
  console.error("[BigRAG CLI] Error:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
