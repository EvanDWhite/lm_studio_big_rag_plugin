# Big RAG Stories (LM Studio plugin)

**Big RAG Stories** (`evandwhite/big-rag-stories`) is a fork of [Big RAG](https://github.com/ari99/lm_studio_big_rag_plugin) (`mindstudio/big-rag`). Each story/title folder gets its own isolated RAG database, and you pick the story per chat.

It installs as a **separate plugin**, with a different manifest owner/name, tool names, log prefix and data folders. It never replaces or collides with an installed upstream Big RAG, and both can be installed side by side.

| | Upstream Big RAG | This fork |
|---|---|---|
| Plugin id (`manifest.json`) | `mindstudio/big-rag` | `evandwhite/big-rag-stories` |
| Name shown in LM Studio | big-rag | big-rag-stories |
| Tools | `big_rag_search`, `big_rag_index_status` | `big_rag_stories_search`, `big_rag_stories_index_status` |
| Status line / logs | `[BigRAG]` | `📚 Big RAG Stories · …` / `[BigRAG-Stories]` |
| Story data | n/a | `~/.lmstudio/big-rag-stories/` (configurable) |

Story stores keep the same on-disk vector format and `.big-rag-embedding.json` as upstream, so `adopt-store` can import an existing upstream store, and legacy mode can still read one.

The text below is the upstream documentation, updated for stories.

## Features

- **Massive Scale**: Designed to handle large document collections (GB to TB scale)
- **Deep Directory Scanning**: Recursively scans all subdirectories
- **Multiple File Formats**: Built-in support for PDF, EPUB, HTML, Markdown, plain text, images (OCR), and more
- **User-defined extensions**: Index extra plain-text types (e.g. `.java`, `.py`, `.rs`) via the **Additional plain-text extensions** setting
- **OCR Support**: Optional OCR for image files using Tesseract
- **Vector Search**: Uses Vectra with sharded indexes for efficient vector storage and retrieval (avoids single-file size limits)
- **Incremental Indexing**: Automatically detects and skips already-indexed files
- **Concurrent Processing**: Configurable concurrency for optimal performance
- **Persistent Storage**: Vector embeddings are stored locally and persist across sessions

## Supported File Types

### Built-in (no extra configuration)

| Category | Extensions |
|----------|------------|
| Documents | `.pdf`, `.epub`, `.txt`, `.text` |
| Markdown | `.md`, `.mdx`, `.markdown`, `.mkd`, `.mkdn`, `.mdown` |
| Web | `.htm`, `.html`, `.xhtml` |
| Images (OCR) | `.bmp`, `.jpeg`, `.jpg`, `.png` |

PDF, EPUB, HTML, and images use dedicated parsers. Plain-text and Markdown files use the text parser.

### Additional plain-text extensions (user-configured)

Any other **plain-text** extension can be indexed by listing it in **Additional plain-text extensions** in the chat Integrations sidebar (or via `BIG_RAG_ADDITIONAL_EXTENSIONS` for CLI indexing).

Common examples:

```
.java
.cs
.py
.rs
.go
.ts
.tsx
.js
.jsx
.c
.cpp
.h
.sql
.yaml
.toml
```

**Format rules:**

- One extension per line, or comma-separated on one line
- With or without a leading dot (`.java` and `java` both work)
- Lines starting with `#` are comments; inline `#` after an extension is also stripped
- Wildcards (`*`, `?`) are not allowed

**Rejected automatically:** binaries and formats that already have dedicated parsers or are unsafe to read as text — e.g. `.exe`, `.zip`, `.jar`, `.docx`, `.pdf`, `.png`. Rejections are logged as `[BigRAG] Rejected additional extension …` in developer logs.

**After changing extensions:** trigger a reindex (empty vector store + chat message, or **Manual Reindex Trigger** ON) so new file types are picked up. Pair with **Exclude filename patterns** when indexing source trees:

```
node_modules/**
target/**
bin/**
dist/**
.git/**
```

**CLI / headless indexing:**

```bash
BIG_RAG_ADDITIONAL_EXTENSIONS=".java;.cs;.py" \
BIG_RAG_DOCS_DIR=/path/to/repo \
BIG_RAG_DB_DIR=/path/to/vectorstore \
npm run index
```

### Not yet supported

- **RAR archives**: listed in built-in types but not implemented (files are skipped)

## Installation

```bash
git clone -b feature/story-dbs https://github.com/EvanDWhite/lm_studio_big_rag_plugin.git big-rag-stories
cd big-rag-stories
npm ci
npm run build
lms dev --install -y      # installs evandwhite/big-rag-stories into LM Studio (LM Studio must have been run once)
```

Then in LM Studio, enable **big-rag-stories** in a chat's integrations/plugins menu. If upstream Big RAG is also installed, enable only one of the two per chat.

Then choose one of the following:

| Goal | Command | Plugin id for REST |
|------|---------|-------------------|
| **Dev** (hot reload, chat UI) | `npm run dev` | Use installed copy for REST (see below) |
| **Local install** (REST + chat) | `lms dev --install -y` | `evandwhite/big-rag-stories` |
| **Publish to Hub** | `lms login` then `lms push -y` | `evandwhite/big-rag-stories` |

After code changes: `npm run build` then re-run `npm run dev`, `lms dev --install -y`, or `lms push -y`.

Hub page: [lmstudio.ai/evandwhite/big-rag-stories](https://lmstudio.ai/evandwhite/big-rag-stories) (only exists once published with `lms push`)

## Installing / "deploy" options

- **Now (from GitHub, no Hub account):** clone the branch and run `lms dev --install -y` (see Installation). LM Studio copies the plugin into its local plugins folder as `evandwhite/big-rag-stories`.
  - Update later with `git pull && npm ci && lms dev --install -y`.
  - For hot reload while hacking, use `lms dev` instead; it shows up as `dev/evandwhite/big-rag-stories` and only lives while the command runs.
- **One-click install (after publishing to LM Studio Hub):**
  - Run `lms login` (browser) then `lms push` from this folder. The manifest `owner` must be your LM Studio Hub username or an org you belong to.
  - The Hub page `https://lmstudio.ai/<owner>/big-rag-stories` then has a **Run in LM Studio** button, which opens `lmstudio://plugin?owner=<owner>&name=big-rag-stories`.
  - A README badge can link to that Hub page. GitHub strips `lmstudio://` links from READMEs, so link the https Hub page.
- **Automated publish (optional, needs secrets):** a GitHub Actions `workflow_dispatch` job can install headless LM Studio (`curl -fsSL https://lmstudio.ai/install.sh | bash`, `lms daemon up`), run `lms login --with-pre-authenticated-keys --key-id … --public-key … --private-key …` from repo secrets, then run `lms push -y`. Not set up yet.
- **CI (ready, not yet enabled):** `contrib/github-workflows/ci.yml` builds and runs the tests on every push and PR, with no secrets. To enable it, move it to `.github/workflows/ci.yml`. Use GitHub's web editor ("Add file"), or push with a token that has the `workflow` scope; the bot's token can't create workflow files.

## Manual testing

**Default chat workflow** — no `lms server start`; the server runs inside the LM Studio app (`http://localhost:1234` when enabled).

1. Open the **LM Studio** desktop app.
2. Load the plugin (pick one):
   - **Dev:** `cd big-rag-plugin && npm run dev` (leave running; good for UI iteration)
   - **Installed (required for REST):** `cd big-rag-plugin && npm run build && lms dev --install -y`
3. Open a **Chat** → right sidebar → **Integrations** (hammer icon) → enable **Big RAG** → expand the row and set **Documents Directory**, **Vector Store Directory**, etc.
4. Send a chat message. The first message auto-indexes if the vector store is empty.

**Automated tests** (no UI):

```bash
cd big-rag-plugin && npm test
```

**Headless indexing** (optional; LM Studio app must be open for embeddings):

```bash
cd big-rag-plugin && npm run index
```

Paths are set in `package.json` `index` script or via `BIG_RAG_DOCS_DIR` / `BIG_RAG_DB_DIR` env vars.

## Story databases (multiple isolated indexes)

Each **story** is its own isolated database: one title folder → one index. Two chats on different stories never see each other's chunks.

**Picking a story in a chat** (Integrations sidebar → Big RAG):
- **Story** dropdown: `None (RAG off)` (default for new chats) plus every story that existed when the plugin started.
- **Story ID override**: type an id to use a story created after the plugin started (or to override the dropdown). Reload the plugin (toggle it off/on, or restart LM Studio) to add new stories to the dropdown.
- Every reply shows a status line such as `📚 Story: The Salt Kingdom (the-salt-kingdom) · via dropdown`, or `📚 Big RAG is off for this chat` when nothing is selected.
- If a chat's saved dropdown choice is no longer listed (story deleted, or a different Stories Root after restart), Big RAG shows an error and searches nothing until you pick again.
- The dropdown is listed at startup from `$BIG_RAG_STORIES_ROOT`, else the Stories Root last used by a chat, else the default (plugins cannot read global settings at startup). Searches always use the current Stories Root setting.

**Creating a story from the chat:** toggle **Create story from title folder**, fill in **New story: title folder** (optional: id, exclude patterns, embedding model), send any message. Then select it via Story ID override (or the dropdown after a reload) and turn the toggle off. Indexing starts on the first message with the story selected.

Open product decisions (REST story argument, overlapping folders, default excludes, prune brake) are single switches in `src/stories/policy.ts`.

- **Stories Root** (global plugin setting): where story databases live. Empty = `$BIG_RAG_STORIES_ROOT`, else `~/.lmstudio/big-rag-stories`.
- Layout: `<root>/stories/<storyId>/story.json` (manifest), `index/` (Vectra shards), `.big-rag-failures.json`.
- Create a story from a title folder (defaults: index **every subfolder** except `**/chapter_raw/**`):

  ```bash
  npm run build
  node dist/cliIndex.js create-story "/path/to/The Salt Kingdom"      # id: the-salt-kingdom
  node dist/cliIndex.js list-stories
  node dist/cliIndex.js index --story the-salt-kingdom                # optional; chat auto-indexes an empty story
  ```

  Options: `--id`, `--name`, `--model <embedding model>`, `--exclude <glob>` (repeatable; replaces the default), `--chunk-size`, `--chunk-overlap`, `--stories-root`.
- `story.json` holds the story's source folders (`titleDir` + `sourceDirs`, default `["."]`), `excludePatterns`, `additionalExtensions`, embedding model + dimensions, chunk settings, OCR flag and stats. Edit it to change per-story settings; reindex after changing model or chunking.
- Every chunk is stamped with `metadata.storyId`; search drops anything not stamped for the chat's story. Reindexing a story also prunes chunks for files that were deleted, moved out, or are now excluded (skipped if a source folder is missing).
- **Fail closed:** if no story is selected and the legacy paths are not both set, or the selected story does not exist, Big RAG does nothing (no indexing, no search) and the message goes to the model unchanged.

### Adopting an existing store as a story (no re-embedding)

If you already have a Big RAG vector store for a title, `adopt-store` turns it into a story without embedding anything again:

```bash
npm run build
# 1. Look first. Writes nothing.
node dist/cliIndex.js adopt-store --store "/path/to/old/vector-store" "/path/to/Title Folder" --dry-run
# 2. Adopt. Copies the store, so the original stays untouched as a backup.
node dist/cliIndex.js adopt-store --store "/path/to/old/vector-store" "/path/to/Title Folder"
```

- **Auto-detected:**
  - the embedding model (from the store's `.big-rag-embedding.json`)
  - dimensions (from the vectors)
  - chunk size and overlap (inferred from chunk word offsets)
  - the old documents folder (the common folder of all chunk paths)
  - a path remap, if the documents have moved since indexing
- **Needed from you:** `--store` and the title folder. You also need `--model` if the store has no `.big-rag-embedding.json`.
- **The dry run reports:**
  - detected settings and where each came from
  - chunk and file counts
  - how many map inside vs outside the title folder
  - excluded (`chapter_raw`) chunks
  - what the **first reindex** would skip, re-embed, embed new, or **prune**, with a clear ⚠ warning before anything would be pruned
- **What it does:**
  - copies `shard_*` into `<root>/stories/<id>/index/`
  - rewrites ids to `<id>:<oldId>`
  - stamps `metadata.storyId`
  - makes paths relative to the title folder, adding `subfolder`
  - verifies chunk count, stamps and vectors
  - writes `story.json` last (with a `migration` record)

  Vectors are byte-identical.
- **Options:**
  - `--id`, `--name`
  - `--exclude <glob>`: repeatable; the default is `**/chapter_raw/**`
  - `--chunk-size`/`--chunk-overlap`: override the inferred values
  - `--path-map OLD=NEW`: repeatable
  - `--no-auto-map`
  - `--stories-root`
  - `--prune`: drop chunks the first reindex would prune (outside the title folder, excluded, deleted). Off by default.
  - `--move`: move the original store instead of copying it. Off by default.
- After adopting, keep **Skip Previously Indexed** ON for the first reindex. Unchanged files are skipped; only changed and new files are embedded.

**Prune safety:**
- Story reindexing prunes chunks for files that left the sources, and shows a ⚠ status listing them first.
- It skips pruning entirely if more than half of a story's indexed files (4 or more) would go. This usually means a wrong or unmounted folder. Tune this with `maxPruneFraction` in `src/stories/policy.ts`.

Story chunk paths are stored relative to the title folder (e.g. `characters/mira.md`), and citations show that path. Stories indexed before this change keep their absolute paths and keep working.

**Legacy single-store mode** still works: leave Story at None and Story ID override empty, and set both **Documents Directory (legacy)** and **Vector Store Directory (legacy)**. Fields marked *(legacy)* apply only in that mode; stories take them from `story.json`.

## Configuration

All per-chat plugin fields appear in the **chat Integrations sidebar** when Big RAG is enabled (expand the plugin row). The only global setting is **Stories Root** (plugin settings).

The plugin provides the following configuration options:

### Required Settings

- **Documents Directory**: Root directory containing your documents (read access required). Multiple roots are supported — separate them with commas or put each on its own line. Example: `/docs/a, /docs/b`. Missing paths are skipped with a warning.
- **Vector Store Directory**: Where the vector database will be stored (read/write access required)

### Embedding model

- **Embedding Model** (plugin setting): String passed to LM Studio’s embedding load API. **Both** common forms can work for the same weights—for example **`mixedbread-ai/mxbai-embed-large-v1`** (Hub / `lms get`) and **`text-embedding-mxbai-embed-large-v1`** (as shown in `lms ls`). Use **one** spelling consistently for indexing and retrieval so it matches **`.big-rag-embedding.json`**; switching spelling without reindexing can trigger a mismatch warning. Default: `nomic-ai/nomic-embed-text-v1.5-GGUF`.
- **After changing the embedding model**, run a **full reindex** (toggle *Manual Reindex Trigger* with *Skip Previously Indexed Files* off, or clear the vector store and let first-run indexing rebuild). Vectors from different models are not comparable in the same index.
- **`.big-rag-embedding.json`**: Written under the vector store directory when the index has at least one chunk; records the model id and vector length used to build the index. If the configured model no longer matches this file, retrieval is blocked until you reindex or revert the setting. If the index has **zero** chunks, this file is removed so metadata cannot drift (including after manual shard deletion).
- **Indexes built with older plugin versions** may have chunks but no manifest; retrieval still works, and a full reindex will create the manifest.

### Retrieval Settings

- **Retrieval Limit** (1-20, default: 5): Maximum number of chunks to return
- **Retrieval Affinity Threshold** (0.0-1.0, default: 0.5): Minimum similarity score for relevance
- **Chunk Size** (128-2048 words, default: 512): Size of text chunks for embedding
- **Chunk Overlap** (0-512 words, default: 100): Overlap between consecutive chunks

### Performance Settings

- **Max Concurrent Files** (1-10, default: 1): Number of files to process simultaneously
- **Enable OCR** (default: true): Enable OCR for image files and image-based PDFs using LM Studio's built-in document parser

### File indexing filters

- **Exclude filename patterns**: Optional globs (one per line) matched against paths relative to the Documents Directory. Example: `*.png`, `node_modules/**`, `target/**`. Applied after the extension gate; does not remove chunks already in the vector store.
- **Additional plain-text extensions**: See [Additional plain-text extensions](#additional-plain-text-extensions-user-configured) above. Configured in the same sidebar block; files matching listed extensions are read as UTF-8 plain text and chunked like `.txt`.

CLI equivalents: `BIG_RAG_EXCLUDE_PATTERNS` and `BIG_RAG_ADDITIONAL_EXTENSIONS` (semicolon-separated for env vars).

### Reindexing Controls

- **Manual Reindex Trigger** (toggle): Turn ON, then send a chat message to run indexing. It does **not** auto-reset — turn it OFF again when finished, or every subsequent chat with the plugin enabled will reindex.
- **Skip Previously Indexed Files** (default: true): When Manual Reindex is on, skip unchanged files (hash match). Turn this OFF for a full rebuild of every file.
- **Automatic First-Run**: If the vector store is empty, the plugin automatically indexes the configured documents the first time any chat message is processed—no manual input is required.

## Usage

1. **Configure the plugin** (one place — the chat sidebar):
   - Open a **Chat** in LM Studio
   - Right sidebar → **Integrations** tab (hammer icon) — **not** Settings → Integrations
   - Enable **Big RAG** and **expand** the plugin row to show config fields
   - Set **Documents Directory** (e.g. `/Users/user/Documents/MyLibrary`)
   - Set **Vector Store Directory** (e.g. `/Users/user/.lmstudio/big-rag-stories-legacy-db`)

   Settings → Integrations (gear menu) only controls tool-call confirmation — **not** document paths.

2. **Initial indexing**:
   - The first chat message triggers a scan/index if the vector store is empty
   - Progress appears in LM Studio developer logs (`[BigRAG]` lines)

3. **Query your documents**:
   - Chat normally; the prompt preprocessor injects relevant passages automatically

## Using Big RAG via REST API

Big RAG registers a **prompt preprocessor** (automatic RAG in chat) and a **tools provider** (`big_rag_stories_search`, `big_rag_stories_index_status`) for `/api/v1/chat`.

### Prerequisites

1. LM Studio app open with local server enabled (`http://localhost:1234`).
2. Plugin **installed** locally or from Hub — REST requires id `"evandwhite/big-rag-stories"` (`owner/name` from `manifest.json`). The dev id (`dev/evandwhite/big-rag-stories` from `npm run dev`) works in chat UI but **not** in REST.
3. Install/update: `npm run build && lms dev --install -y` (local) or `lms push -y` (Hub).
4. LM Studio **Server Settings**: enable **Allow calling servers from mcp.json** (required for plugin integrations).
5. If API auth is on: create a token and pass `Authorization: Bearer $LM_API_TOKEN` ([docs](https://lmstudio.ai/docs/developer/core/authentication)).
6. Load an LLM and embedding model in LM Studio.

### REST configuration (tools)

REST tool calls have **no chat session**, so they have no Story ID. Pass the story explicitly: tools accept an optional `story` argument (e.g. ask the model to "use big_rag_stories_search with story the-salt-kingdom"). Without it, tools return `Error: No story selected` and search nothing.

There is **no fallback** to a synced `~/.lmstudio/big-rag-tools-config.json` or `BIG_RAG_DOCS_DIR` / `BIG_RAG_DB_DIR` env vars any more (that fallback could silently search another chat's store). Inside a chat, the chat's own story is always used, and a `story` argument naming a different story is refused.

### Native REST API (`/api/v1/chat`)

Load your API token (example: repo-root `.env`):

```bash
export $(grep -v '^#' .env | xargs)   # sets LM_API_TOKEN
```

**Index status** (one tool — reliable):

```bash
curl -s http://127.0.0.1:1234/api/v1/chat \
  -H "Authorization: Bearer $LM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-id",
    "input": "Call big_rag_stories_index_status and report totalChunks.",
    "integrations": [{
      "type": "plugin",
      "id": "evandwhite/big-rag-stories",
      "allowed_tools": ["big_rag_stories_index_status"]
    }],
    "temperature": 0
  }' | python3 -m json.tool
```

**Search** (one tool — use `limit 3` in the prompt to avoid context overflow):

```bash
curl -s http://127.0.0.1:1234/api/v1/chat \
  -H "Authorization: Bearer $LM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-id",
    "input": "Use big_rag_stories_search to find content about rifle cleaning. Use limit 3.",
    "integrations": [{
      "type": "plugin",
      "id": "evandwhite/big-rag-stories",
      "allowed_tools": ["big_rag_stories_search"]
    }],
    "temperature": 0
  }' | python3 -m json.tool
```

**Preprocessor-only RAG** (no explicit tools — needs a chat config with a Story ID or legacy paths; a bare REST request has none, so nothing is injected):

```bash
curl -s http://127.0.0.1:1234/api/v1/chat \
  -H "Authorization: Bearer $LM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-id",
    "input": "What does the documentation say about rifling?",
    "integrations": [{
      "type": "plugin",
      "id": "evandwhite/big-rag-stories"
    }],
    "temperature": 0
  }' | python3 -m json.tool
```

### Plugin tools

| Tool | Description |
|------|-------------|
| `big_rag_stories_search` | Embed a query and return matching passages (JSON with scores and file names) |
| `big_rag_stories_index_status` | Return the story's chunk count, unique file count, source folders and index dir |

### REST limitations (observed behavior)

- **One tool per request** works reliably. Prompts like “first call X, then Y” may fail with `tool_format_generation_error` because smaller models (e.g. Llama 3.1 8B) emit multiple tool calls in one generation block. Run separate curl requests instead.
- **Large tool outputs**: `big_rag_stories_search` with `limit=10` returns full passage text and can exceed the model context window (e.g. 14848 tokens). Ask for `limit 3` or increase context length in LM Studio.
- **Permission denied**: enable “Allow calling servers from mcp.json” and use a valid API token.
- **“No story selected”**: pass `story` in the request (REST), or set Story ID in the chat.
- Use the same **Embedding Model** for indexing and retrieval; reindex after changing models.

### OpenAI-compatible `/v1/chat/completions`

LM Studio does **not** support plugin `integrations` on the OpenAI-compatible chat endpoint. That is a platform limitation (not something this plugin can enable).

- Feature matrix: [LM Studio REST overview](https://lmstudio.ai/docs/developer/rest) (MCP/plugins are unsupported on `/v1/chat/completions`)
- OpenAI params (no `integrations` field): [Chat Completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions)
- Working path: native [`POST /api/v1/chat`](https://lmstudio.ai/docs/developer/rest/chat) with an `integrations` block (examples above)

## Common Use Cases

**Source code / repo RAG**

Point **Documents Directory** at a project root, add extensions, and exclude build artifacts:

```
Additional plain-text extensions:
.java
.py
.ts
.tsx

Exclude filename patterns:
node_modules/**
target/**
dist/**
.git/**
```

Reindex after changing extensions. Check developer logs for `[Scanner] Additional plain-text extensions: …` on startup.

**Technical documentation**

Larger **Chunk Size** (1024) and default retrieval settings work well for manuals and API docs.

## Architecture

### Components

1. **File Scanner** (`src/ingestion/fileScanner.ts`):
   - Recursively scans directories
   - Filters for supported file types
   - Collects file metadata

2. **Document Parsers** (`src/parsers/`):
   - `htmlParser.ts`: Extracts text from HTML/HTM files
   - `pdfParser.ts`: Extracts text from PDF files
   - `epubParser.ts`: Extracts text from EPUB files
   - `textParser.ts`: Reads plain text & Markdown files with optional Markdown stripping
   - `imageParser.ts`: OCR for image files
   - `documentParser.ts`: Routes to appropriate parser

3. **Vector Store** (`src/vectorstore/vectorStore.ts`):
   - Uses Vectra with sharded indexes (one shard in memory at a time; avoids V8 string size limits)
   - Supports incremental updates
   - Efficient similarity search

4. **Index Manager** (`src/ingestion/indexManager.ts`):
   - Orchestrates the indexing pipeline
   - Manages concurrent processing
   - Handles progress reporting

5. **Prompt Preprocessor** (`src/promptPreprocessor.ts`):
   - Intercepts user queries
   - Performs vector search
   - Injects relevant context

6. **Retrieval module** (`src/rag/retrieval.ts`):
   - Shared vector store cache, search, and citation formatting
   - Used by the prompt preprocessor and tools provider

7. **Tools Provider** (`src/toolsProvider.ts`):
   - Exposes `big_rag_stories_search` and `big_rag_stories_index_status` for REST API / agent integrations

## Performance Considerations

### Large Datasets

- **Disk Space**: The vector store requires additional disk space (typically 10-20% of original document size)
- **Initial Indexing**: Can take several hours for TB-scale collections
- **Memory Usage**: Scales with concurrent processing (reduce `maxConcurrentFiles` if needed)

### Optimization Tips

1. **Start Small**: Test with a subset of documents first
2. **Disable OCR**: Unless you have many image-based documents, keep OCR disabled
3. **Adjust Concurrency**: Lower `maxConcurrentFiles` on systems with limited resources
4. **Chunk Size**: Larger chunks (1024-2048) work better for technical documents
5. **Threshold Tuning**: Adjust `retrievalAffinityThreshold` based on result quality

## Troubleshooting

### REST: “No story selected”

- Pass the story id via the tool's `story` argument (REST has no chat Story ID).
- Check the id with `node dist/cliIndex.js list-stories` and that **Stories Root** matches.
- Ensure REST uses `"evandwhite/big-rag-stories"` and the plugin is installed (`lms dev --install -y`).

### REST: `tool_format_generation_error`

- Use **one tool per curl request** (`allowed_tools` with a single entry).
- Avoid “first call X, then Y” in one prompt; chain with separate requests.

### REST: “Context size has been exceeded”

- Lower search results: include “limit 3” in the prompt.
- Increase context length for your LLM in LM Studio.
- Do not stack multiple large tool results in one session.

### REST: “Permission denied to use plugin”

- Server Settings → enable **Allow calling servers from mcp.json**.
- Pass `Authorization: Bearer $LM_API_TOKEN` if API auth is enabled.

### No Results Found

- Check that documents directory is correctly configured
- Verify that indexing completed successfully
- Try lowering the retrieval affinity threshold
- Check LM Studio logs for errors

### Additional extensions not indexed

- Confirm extensions are listed in **Additional plain-text extensions** (sidebar) or `BIG_RAG_ADDITIONAL_EXTENSIONS`
- Check logs for `[BigRAG] Rejected additional extension` (binary/built-in types are blocked)
- Reindex after adding new extensions — existing index does not retroactively scan new types
- Use **Exclude filename patterns** if files live under ignored folders (`node_modules/**`, etc.)

### Embedding model mismatch

- If you see a message that the index was built with a **different embedding model** than the one in settings, either change **Embedding Model** back to the value recorded in `.big-rag-embedding.json` or run a **full reindex** after changing the model.
- **Dimension mismatch** means the model’s output size changed; reindex after switching models or quantizations.

### Slow Indexing

- Reduce `maxConcurrentFiles`
- Disable OCR if not needed
- Ensure vector store directory is on a fast drive (SSD recommended)

### Out of Memory

- Reduce `maxConcurrentFiles` to 1 or 2
- Process documents in batches by organizing them into subdirectories
- Increase system swap space

### OCR Not Working

- Tesseract.js downloads language data on first use
- Ensure internet connectivity during first OCR operation
- Check that image files are valid and readable

### Failure Reason Reporting

- The CLI logs cumulative `success` / `failed` counts after each processed document.
- Set `BIG_RAG_FAILURE_REPORT_PATH=/absolute/path/report.json` when running `npm run index` (or via LM Studio env settings) to emit a JSON report containing all failure reasons and counts after indexing completes. This is useful when triaging stubborn PDFs such as blueprints or large scanned books.
- **`BIG_RAG_EMBEDDING_MODEL`**: Optional. When set for headless indexing (`npm run index:cli` / `dist/cliIndex.js`), overrides the default embedding model id (same default as the plugin’s **Embedding Model** setting). Empty/unset uses the built-in default from `config.ts`.

## Limitations

- **RAR Archives**: Not yet implemented (files are skipped)
- **Password-Protected Files**: Not supported
- **Very Large Files**: Individual files >100MB may cause memory issues
- **Non-English OCR**: Currently only English OCR is configured

## Development

### Project Structure

```
big-rag-plugin/
├── src/
│   ├── config.ts              # Plugin configuration schema
│   ├── index.ts               # Main entry point
│   ├── promptPreprocessor.ts  # RAG integration
│   ├── toolsProvider.ts       # REST tools (search + index status)
│   ├── rag/
│   │   └── retrieval.ts       # Shared search / vector store cache
│   ├── ingestion/
│   │   ├── fileScanner.ts     # Directory scanning
│   │   └── indexManager.ts    # Indexing orchestration
│   ├── parsers/
│   │   ├── documentParser.ts  # Parser router
│   │   ├── htmlParser.ts      # HTML parsing
│   │   ├── pdfParser.ts       # PDF parsing
│   │   ├── epubParser.ts      # EPUB parsing
│   │   ├── textParser.ts      # Text parsing
│   │   └── imageParser.ts     # OCR parsing
│   ├── vectorstore/
│   │   └── vectorStore.ts     # Vectra sharded index integration
│   └── utils/
│       ├── additionalExtensions.ts  # User-defined plain-text extension parsing
│       ├── coerceEmbedding.ts       # Normalize embedding API vectors
│       ├── effectivePluginConfig.ts # Chat ↔ REST tools config sync
│       ├── embeddingIndexManifest.ts # Index embedding metadata on disk
│       ├── fileHash.ts              # File hashing
│       └── textChunker.ts           # Text chunking (by words)
├── manifest.json              # Plugin manifest
├── package.json               # Dependencies
├── tsconfig.json              # TypeScript config
└── README.md                  # This file
```

### Testing

See **Manual testing** at the top of this README. Summary:

- `npm test` — unit tests (extensions, parsers, retrieval helpers)
- `npm run dev` + LM Studio chat — E2E UI (dev plugin)
- `npm run build && lms dev --install -y` + curl to `/api/v1/chat` — E2E REST (installed plugin id `evandwhite/big-rag-stories`; config synced via chat message or env vars)

### Contributing

This plugin is based on the LM Studio plugin SDK. For more information:

- [lmstudio-js GitHub](https://github.com/lmstudio-ai/lmstudio-js)
- [Documentation](https://lmstudio.ai/docs)
- [Discord](https://discord.gg/6Q7Xn6MRVS)

## License

ISC

## Acknowledgments

- Built using the LM Studio SDK
- Uses Vectra for vector storage (sharded indexes)
- OCR powered by Tesseract.js
- PDF parsing via pdf-parse
- EPUB parsing via epub2
- HTML parsing via cheerio

