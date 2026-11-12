import { createConfigSchematics } from "@lmstudio/sdk";

/** Default embedding model id (must match CLI default when env is unset). */
export const DEFAULT_EMBEDDING_MODEL_ID = "nomic-ai/nomic-embed-text-v1.5-GGUF";

export function resolveEmbeddingModelId(raw: string | undefined | null): string {
  const t = typeof raw === "string" ? raw.trim() : "";
  return t.length > 0 ? t : DEFAULT_EMBEDDING_MODEL_ID;
}

export const DEFAULT_PROMPT_TEMPLATE = `{{rag_context}}

Use the citations above to respond to the user query, only if they are relevant. Otherwise, respond to the best of your ability without them.

User Query:

{{user_query}}`;

export const configSchematics = createConfigSchematics()
  .field(
    "storyId",
    "string",
    {
      displayName: "Story ID",
      subtitle:
        "Story database for THIS chat (e.g. the-salt-kingdom). Stories live under the global Stories Root " +
        "(<root>/stories/<id>/story.json); create one with `node dist/cliIndex.js create-story <titleDir>`. " +
        "When set, the story's own source folders, excludes, embedding model and chunk settings are used and the " +
        "legacy fields below are ignored. Leave empty AND leave the legacy paths empty to turn retrieval off.",
      placeholder: "the-salt-kingdom",
    },
    "",
  )
  .field(
    "documentsDirectory",
    "string",
    {
      displayName: "Documents Directory (legacy)",
      subtitle:
        "Legacy single-store mode, used only when Story ID is empty and Vector Store Directory is also set. " +
        "Root directories containing documents to index. All subdirectories will be scanned. " +
        "Multiple paths are supported: separate them with commas or put each on its own line. " +
        "Missing paths are skipped with a warning.",
      placeholder:
        "/path/to/documents, /other/docs, D:\\archive\n" +
        "Example: C:/docs, D:/library, E:/notes",
      isParagraph: true,
    },
    "",
  )
  .field(
    "vectorStoreDirectory",
    "string",
    {
      displayName: "Vector Store Directory (legacy)",
      subtitle:
        "Legacy single-store mode, used only when Story ID is empty and Documents Directory is also set. " +
        "Directory where the vector database will be stored.",
      placeholder: "/path/to/vector/store",
    },
    "",
  )
  .field(
    "embeddingModel",
    "string",
    {
      displayName: "Embedding Model (legacy)",
      subtitle:
        "Legacy mode only (stories record their model in story.json). LM Studio accepts more than one spelling for the same model—for example mixedbread-ai/mxbai-embed-large-v1 (Hub / download) or text-embedding-mxbai-embed-large-v1 (as in lms ls). Both are valid; use one value consistently for indexing and chat so it matches .big-rag-embedding.json. Reindex after changing.",
      placeholder: DEFAULT_EMBEDDING_MODEL_ID,
    },
    DEFAULT_EMBEDDING_MODEL_ID,
  )
  .field(
    "retrievalLimit",
    "numeric",
    {
      int: true,
      min: 1,
      max: 20,
      displayName: "Retrieval Limit",
      subtitle: "Maximum number of chunks to return during retrieval.",
      slider: { min: 1, max: 20, step: 1 },
    },
    5,
  )
  .field(
    "retrievalAffinityThreshold",
    "numeric",
    {
      min: 0.0,
      max: 1.0,
      displayName: "Retrieval Affinity Threshold",
      subtitle: "Minimum similarity score for a chunk to be considered relevant.",
      slider: { min: 0.0, max: 1.0, step: 0.01 },
    },
    0.5,
  )
  .field(
    "chunkSize",
    "numeric",
    {
      int: true,
      min: 128,
      max: 2048,
      displayName: "Chunk Size (legacy)",
      subtitle: "Size of text chunks for embedding (in words).",
      slider: { min: 128, max: 2048, step: 128 },
    },
    512,
  )
  .field(
    "chunkOverlap",
    "numeric",
    {
      int: true,
      min: 0,
      max: 512,
      displayName: "Chunk Overlap (legacy)",
      subtitle: "Overlap between consecutive chunks (in words).",
      slider: { min: 0, max: 512, step: 32 },
    },
    100,
  )
  .field(
    "maxConcurrentFiles",
    "numeric",
    {
      int: true,
      min: 1,
      max: 10,
      displayName: "Max Concurrent Files",
      subtitle: "Maximum number of files to process concurrently during indexing. Recommend 1 for large PDF datasets.",
      slider: { min: 1, max: 10, step: 1 },
    },
    1,
  )
  .field(
    "parseDelayMs",
    "numeric",
    {
      int: true,
      min: 0,
      max: 5000,
      displayName: "Parser Delay (ms)",
      subtitle: "Wait time before parsing each document (helps avoid WebSocket throttling).",
      slider: { min: 0, max: 5000, step: 100 },
    },
    500,
  )
  .field(
    "enableOCR",
    "boolean",
    {
      displayName: "Enable OCR (legacy)",
      subtitle: "Enable OCR for image files and image-based PDFs using LM Studio's built-in document parser.",
    },
    true,
  )
  .field(
    "excludeFilenamePatterns",
    "string",
    {
      displayName: "Exclude filename patterns (legacy)",
      subtitle:
        "Optional. One glob per line, matched against each file path relative to Documents Directory (use /). Lines starting with # are comments. Example: *.png excludes PNGs in any folder; archive/** excludes that subtree. Does not remove chunks already in the vector store—clear or reindex to drop old data.",
      placeholder: "*.png\n# *.jpg",
      isParagraph: true,
    },
    "",
  )
  .field(
    "additionalExtensions",
    "string",
    {
      displayName: "Additional plain-text extensions (legacy)",
      subtitle:
        "Optional. One extension per line (e.g. .java, .cs, .py). Files are read as plain text. Binaries such as .exe and .zip are rejected. Built-in types like PDF and EPUB do not need to be listed.",
      placeholder: ".java\n.cs\n.py",
      isParagraph: true,
    },
    "",
  )
  .field(
    "manualReindex.trigger",
    "boolean",
    {
      displayName: "Manual Reindex Trigger",
      subtitle:
        "Toggle ON to reindex on the next chat message. Turn it OFF again afterward (it does not auto-reset). Use “Skip Previously Indexed Files” to skip unchanged files.",
    },
    false,
  )
  .field(
    "manualReindex.skipPreviouslyIndexed",
    "boolean",
    {
      displayName: "Skip Previously Indexed Files",
      subtitle: "Skip unchanged files for faster manual runs. Only indexes new files or changed files.",
      dependencies: [
        {
          key: "manualReindex.trigger",
          condition: { type: "equals", value: true },
        },
      ],
    },
    true,
  )
  .field(
    "promptTemplate",
    "string",
    {
      displayName: "Prompt Template",
      subtitle:
        "Supports {{rag_context}} (required) and {{user_query}} macros for customizing the final prompt.",
      placeholder: DEFAULT_PROMPT_TEMPLATE,
      isParagraph: true,
    },
    DEFAULT_PROMPT_TEMPLATE,
  )
  .build();


/** Application-wide settings (plugin management screen). */
export const globalConfigSchematics = createConfigSchematics()
  .field(
    "storiesRoot",
    "string",
    {
      displayName: "Stories Root",
      subtitle:
        "Folder that holds all story databases (<root>/stories/<storyId>/). Leave empty for the default: " +
        "$BIG_RAG_STORIES_ROOT if set, otherwise ~/.lmstudio/big-rag-stories.",
      placeholder: "~/.lmstudio/big-rag-stories",
    },
    "",
  )
  .build();
