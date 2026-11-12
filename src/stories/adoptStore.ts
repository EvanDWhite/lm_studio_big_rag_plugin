/**
 * Adopt an existing legacy (pre-story) Big RAG vector store into a story WITHOUT re-embedding.
 *
 * Nothing here talks to LM Studio: vectors are copied byte-for-byte from the old shards and only
 * ids/metadata are rewritten. The original store is never modified unless mode === "move".
 *
 * Order of a real run (story.json is written LAST, so a failed run never leaves a half-adopted
 * story that the plugin would pick up):
 *   1. read + analyse the old store (also everything `dryRun` reports)
 *   2. validate the new story (id free, no source overlap, destination absent)
 *   3. copy (or move) shard_* into <storiesRoot>/<id>/index/
 *   4. rewrite each shard's index.json: id -> "<storyId>:<oldId>", metadata.storyId, relative
 *      filePath, subfolder; optionally drop chunks the first reindex would prune (--prune)
 *   5. verify chunk count, stamps and vectors
 *   6. write .big-rag-embedding.json, then story.json
 */
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { scanDirectory } from "../ingestion/fileScanner";
import { resolveAdditionalExtensions } from "../utils/additionalExtensions";
import { calculateFileHash } from "../utils/fileHash";
import { matchExcludePattern } from "../utils/fileExcludePatterns";
import {
  EMBEDDING_INDEX_MANIFEST_FILENAME,
  readEmbeddingIndexManifest,
} from "../utils/embeddingIndexManifest";
import { getStoryPolicy, type StoryPolicy } from "./policy";
import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  STORY_FAILURES_FILENAME,
  getStoryDir,
  prepareNewStory,
  slugifyStoryId,
  writeJsonAtomic,
  type StoryManifest,
} from "./storyRegistry";
import { isInside, subfolderOf, toStoredPath } from "./storyPaths";

const SHARD_DIR_RE = /^shard_\d+$/;

export interface PathMapping {
  from: string;
  to: string;
}

export interface AdoptStoreOptions {
  /** The legacy store folder (the old "Vector Store Directory"). */
  storeDir: string;
  /** The title folder this store's documents now live in. */
  titleDir: string;
  storiesRoot: string;
  id?: string;
  displayName?: string;
  /** Only needed when the store has no .big-rag-embedding.json. */
  embeddingModelId?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  excludePatterns?: string[];
  additionalExtensions?: string[];
  /** Explicit OLD=NEW prefix rewrites, applied before relativizing. */
  pathMaps?: PathMapping[];
  /** Try to remap old paths that no longer exist onto the title folder (default true). */
  autoPathMap?: boolean;
  /** "copy" (default) never touches the original store. */
  mode?: "copy" | "move";
  dryRun?: boolean;
  /** Drop chunks the first reindex would prune (outside title folder / excluded / deleted). Default false. */
  prune?: boolean;
  policy?: Readonly<StoryPolicy>;
}

export type PruneReason = "outside-title-folder" | "excluded" | "missing-on-disk" | "unsupported-type";

export interface FilePlanEntry {
  oldPath: string;
  mappedPath: string;
  storedPath: string;
  fileHash: string;
  chunks: number;
  /** What the first reindex (Skip Previously Indexed = ON) will do with this file. */
  firstReindex: "unchanged" | "re-embed" | "prune";
  pruneReason?: PruneReason;
}

export interface AdoptReport {
  dryRun: boolean;
  mode: "copy" | "move";
  storeDir: string;
  titleDir: string;
  storyId: string;
  displayName: string;
  storyDir: string;
  indexDir: string;
  shards: number;
  totalChunks: number;
  totalFiles: number;
  embedding: { modelId: string | null; dimensions: number; source: "manifest" | "flag" | "missing" };
  chunking: {
    chunkSize: number;
    chunkOverlap: number;
    source: "inferred" | "flag" | "default";
    /** Files with >= 2 chunks that agree with the inferred values / all such files. */
    evidence?: { agreeing: number; sampled: number };
  };
  oldDocumentsFolder: string | null;
  oldTopFolders: Array<{ folder: string; files: number; chunks: number }>;
  pathMapsApplied: PathMapping[];
  inside: { files: number; chunks: number };
  outside: { files: number; chunks: number };
  excluded: { files: number; chunks: number; patterns: string[] };
  firstReindex: {
    unchanged: { files: number; chunks: number };
    reEmbed: { files: number; chunks: number };
    newFiles: { files: number; examples: string[] };
    prune: { files: number; chunks: number; byReason: Record<PruneReason, number>; examples: string[] };
  };
  pruneNow: boolean;
  chunksAdopted: number;
  chunksDropped: number;
  files: FilePlanEntry[];
  warnings: string[];
  /** Problems that block a real run (dry-run still reports everything). */
  errors: string[];
}

interface RawItem {
  id: string;
  metadata: Record<string, any>;
  vector: number[];
  norm?: number;
  metadataFile?: string;
  [k: string]: unknown;
}

interface RawShard {
  name: string;
  file: string;
  json: { version?: number; metadata_config?: unknown; items: RawItem[]; [k: string]: unknown };
}

export class AdoptStoreError extends Error {}

async function readShards(storeDir: string): Promise<RawShard[]> {
  if (!fs.existsSync(storeDir) || !fs.statSync(storeDir).isDirectory()) {
    throw new AdoptStoreError(`Store folder not found: ${storeDir}`);
  }
  const names = (await fsp.readdir(storeDir)).filter((n) => SHARD_DIR_RE.test(n)).sort();
  if (names.length === 0) {
    throw new AdoptStoreError(
      `No shard_NNN folders in ${storeDir}. Point --store at the old "Vector Store Directory".`,
    );
  }
  const shards: RawShard[] = [];
  for (const name of names) {
    const file = path.join(storeDir, name, "index.json");
    if (!fs.existsSync(file)) continue; // empty/uninitialised shard
    const json = JSON.parse(await fsp.readFile(file, "utf-8"));
    if (!json || !Array.isArray(json.items)) {
      throw new AdoptStoreError(`Unrecognised shard format: ${file}`);
    }
    for (const item of json.items as RawItem[]) {
      if (item.metadataFile) {
        throw new AdoptStoreError(
          `Shard ${name} keeps metadata in a side file (metadataFile); this store layout is not supported.`,
        );
      }
    }
    shards.push({ name, file, json });
  }
  return shards;
}

function mode<T>(values: T[]): { value: T; count: number } | null {
  const counts = new Map<string, { value: T; count: number }>();
  for (const v of values) {
    const k = JSON.stringify(v);
    const e = counts.get(k) ?? { value: v, count: 0 };
    e.count++;
    counts.set(k, e);
  }
  let best: { value: T; count: number } | null = null;
  for (const e of counts.values()) if (!best || e.count > best.count) best = e;
  return best;
}

/**
 * Chunks carry word offsets (startIndex/endIndex). For a file with >= 2 chunks, a non-final chunk
 * spans chunkSize words and consecutive chunks start (chunkSize - overlap) words apart.
 */
export function inferChunking(
  items: Array<{ metadata: Record<string, any> }>,
): { chunkSize: number; chunkOverlap: number; agreeing: number; sampled: number } | null {
  const byFile = new Map<string, Array<Record<string, any>>>();
  for (const { metadata: m } of items) {
    if (typeof m.startIndex !== "number" || typeof m.endIndex !== "number") continue;
    const key = `${m.filePath}\u0000${m.fileHash}`;
    const list = byFile.get(key) ?? [];
    list.push(m);
    byFile.set(key, list);
  }
  const samples: Array<[number, number]> = [];
  for (const list of byFile.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.startIndex - b.startIndex);
    const size = list[0].endIndex - list[0].startIndex;
    const step = list[1].startIndex - list[0].startIndex;
    if (size > 0 && step > 0 && step <= size) samples.push([size, size - step]);
  }
  const best = mode(samples);
  if (!best) return null;
  return { chunkSize: best.value[0], chunkOverlap: best.value[1], agreeing: best.count, sampled: samples.length };
}

/** Deepest folder containing every path. */
export function commonAncestor(paths: string[]): string | null {
  const abs = paths.filter((p) => path.isAbsolute(p)).map((p) => path.dirname(path.resolve(p)));
  if (abs.length === 0) return null;
  let parts = abs[0].split(path.sep);
  for (const p of abs.slice(1)) {
    const other = p.split(path.sep);
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  const joined = parts.join(path.sep);
  return joined === "" ? path.parse(abs[0]).root : joined;
}

function applyPathMaps(p: string, maps: PathMapping[]): string {
  for (const m of maps) {
    const from = path.resolve(m.from);
    const resolved = path.resolve(p);
    if (resolved === from || isInside(resolved, from)) {
      return path.join(path.resolve(m.to), path.relative(from, resolved));
    }
  }
  return p;
}

export function parsePathMap(raw: string): PathMapping {
  const idx = raw.indexOf("=");
  if (idx <= 0 || idx === raw.length - 1) {
    throw new AdoptStoreError(`--path-map expects OLD=NEW, got "${raw}"`);
  }
  return { from: raw.slice(0, idx), to: raw.slice(idx + 1) };
}

function emptyCount() {
  return { files: 0, chunks: 0 };
}

export async function adoptLegacyStore(options: AdoptStoreOptions): Promise<AdoptReport> {
  const policy = options.policy ?? getStoryPolicy();
  const runMode = options.mode ?? "copy";
  const dryRun = options.dryRun === true;
  const storeDir = path.resolve(options.storeDir);
  const titleDir = path.resolve(options.titleDir);
  const warnings: string[] = [];
  const errors: string[] = [];

  // ---- 1. Read the old store --------------------------------------------------------------
  const shards = await readShards(storeDir);
  const allItems = shards.flatMap((s) => s.json.items);
  if (allItems.length === 0) {
    throw new AdoptStoreError(`Store ${storeDir} has no chunks; nothing to adopt (just create a story and index).`);
  }
  const alreadyStamped = allItems.filter((i) => typeof i.metadata?.storyId === "string");
  if (alreadyStamped.length > 0) {
    throw new AdoptStoreError(
      `Store already contains ${alreadyStamped.length} story-stamped chunk(s) (storyId "${alreadyStamped[0].metadata.storyId}"). ` +
        `It is already a story store; adopt only legacy stores.`,
    );
  }

  // Embedding: manifest > --model; dimensions from the vectors themselves.
  const dims = new Set(allItems.map((i) => (Array.isArray(i.vector) ? i.vector.length : -1)));
  if (dims.size !== 1 || dims.has(-1) || dims.has(0)) {
    throw new AdoptStoreError(`Store vectors have inconsistent dimensions (${[...dims].join(", ")}); refusing to adopt.`);
  }
  const vectorDims = [...dims][0];
  const manifest = await readEmbeddingIndexManifest(storeDir);
  let embedding: AdoptReport["embedding"];
  if (manifest) {
    embedding = { modelId: manifest.embeddingModelId, dimensions: vectorDims, source: "manifest" };
    if (manifest.dimensions !== vectorDims) {
      errors.push(
        `${EMBEDDING_INDEX_MANIFEST_FILENAME} says ${manifest.dimensions} dimensions but the vectors have ${vectorDims}.`,
      );
    }
    if (options.embeddingModelId && options.embeddingModelId !== manifest.embeddingModelId) {
      errors.push(
        `--model ${options.embeddingModelId} conflicts with the store's recorded model ${manifest.embeddingModelId}. ` +
          `These vectors were made with ${manifest.embeddingModelId}; drop --model.`,
      );
    }
  } else if (options.embeddingModelId) {
    embedding = { modelId: options.embeddingModelId, dimensions: vectorDims, source: "flag" };
    warnings.push(
      `No ${EMBEDDING_INDEX_MANIFEST_FILENAME} in the store; trusting --model ${options.embeddingModelId}. ` +
        `If that is not the model that built the store, retrieval will be garbage (dimensions: ${vectorDims}).`,
    );
  } else {
    embedding = { modelId: null, dimensions: vectorDims, source: "missing" };
    errors.push(
      `The store has no ${EMBEDDING_INDEX_MANIFEST_FILENAME}, so the embedding model can't be detected. ` +
        `Pass --model <the model that built it> (vectors have ${vectorDims} dimensions; nomic-embed-text-v1.5 = 768).`,
    );
  }

  // Chunking: flags > inferred from word offsets > defaults.
  const inferred = inferChunking(allItems);
  let chunking: AdoptReport["chunking"];
  if (options.chunkSize !== undefined || options.chunkOverlap !== undefined) {
    chunking = {
      chunkSize: options.chunkSize ?? inferred?.chunkSize ?? DEFAULT_CHUNK_SIZE,
      chunkOverlap: options.chunkOverlap ?? inferred?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP,
      source: "flag",
    };
    if (inferred && (inferred.chunkSize !== chunking.chunkSize || inferred.chunkOverlap !== chunking.chunkOverlap)) {
      warnings.push(
        `Chunk flags (${chunking.chunkSize}/${chunking.chunkOverlap}) differ from what the store looks like ` +
          `(${inferred.chunkSize}/${inferred.chunkOverlap}). Files re-embedded later will be chunked differently.`,
      );
    }
  } else if (inferred) {
    chunking = {
      chunkSize: inferred.chunkSize,
      chunkOverlap: inferred.chunkOverlap,
      source: "inferred",
      evidence: { agreeing: inferred.agreeing, sampled: inferred.sampled },
    };
    if (inferred.agreeing < inferred.sampled) {
      warnings.push(
        `Chunk settings inferred from ${inferred.agreeing}/${inferred.sampled} multi-chunk files; the rest disagree ` +
          `(settings may have changed between index runs). Pass --chunk-size/--chunk-overlap to override.`,
      );
    }
  } else {
    chunking = { chunkSize: DEFAULT_CHUNK_SIZE, chunkOverlap: DEFAULT_CHUNK_OVERLAP, source: "default" };
    warnings.push(
      `Could not infer chunk size/overlap (no file has 2+ chunks); using defaults ${DEFAULT_CHUNK_SIZE}/${DEFAULT_CHUNK_OVERLAP}. ` +
        `Only affects files re-embedded later. Pass --chunk-size/--chunk-overlap if you used something else.`,
    );
  }
  if (chunking.chunkOverlap >= chunking.chunkSize) {
    errors.push(`Chunk overlap (${chunking.chunkOverlap}) must be smaller than chunk size (${chunking.chunkSize}).`);
  }

  // Files in the store.
  const fileChunks = new Map<string, { hash: string; chunks: number }>();
  for (const item of allItems) {
    const p = String(item.metadata?.filePath ?? "");
    const e = fileChunks.get(p) ?? { hash: String(item.metadata?.fileHash ?? ""), chunks: 0 };
    e.chunks++;
    fileChunks.set(p, e);
  }
  const oldPaths = [...fileChunks.keys()];
  const relativeOld = oldPaths.filter((p) => !path.isAbsolute(p));
  if (relativeOld.length > 0) {
    errors.push(`${relativeOld.length} chunk path(s) are not absolute (e.g. "${relativeOld[0]}"); not a legacy store layout.`);
  }
  const oldDocumentsFolder = commonAncestor(oldPaths);
  const topFolders = new Map<string, { files: number; chunks: number }>();
  if (oldDocumentsFolder) {
    for (const [p, e] of fileChunks) {
      if (!path.isAbsolute(p)) continue;
      const rel = path.relative(oldDocumentsFolder, p).split(path.sep);
      const folder = rel.length > 1 ? rel[0] : ".";
      const t = topFolders.get(folder) ?? { files: 0, chunks: 0 };
      t.files++;
      t.chunks += e.chunks;
      topFolders.set(folder, t);
    }
  }
  if (!fs.existsSync(titleDir) || !fs.statSync(titleDir).isDirectory()) {
    throw new AdoptStoreError(
      `Title folder not found: ${titleDir}` +
        (oldDocumentsFolder ? `\nThe old store's documents were under: ${oldDocumentsFolder}` : ""),
    );
  }

  // Path mapping: explicit maps, then an automatic remap when old paths are gone.
  const pathMaps: PathMapping[] = [...(options.pathMaps ?? [])];
  if (options.autoPathMap !== false && oldDocumentsFolder && pathMaps.length === 0) {
    const afterExplicit = oldPaths.filter((p) => path.isAbsolute(p));
    const missingOutside = afterExplicit.filter((p) => !isInside(p, titleDir) && !fs.existsSync(p));
    if (missingOutside.length > 0 && missingOutside.length === afterExplicit.length) {
      // Every old path is gone: the folder was moved. Try "old docs folder == title folder" and
      // "old docs folder == <title>/<its basename>".
      const candidates = [titleDir, path.join(titleDir, path.basename(oldDocumentsFolder))];
      for (const to of candidates) {
        const m = { from: oldDocumentsFolder, to };
        const hits = afterExplicit.filter((p) => fs.existsSync(applyPathMaps(p, [m]))).length;
        if (hits > 0 && hits >= Math.ceil(afterExplicit.length / 2)) {
          pathMaps.push(m);
          warnings.push(
            `Old document paths no longer exist; auto-mapped ${oldDocumentsFolder} -> ${to} ` +
              `(${hits}/${afterExplicit.length} files found there). Use --path-map OLD=NEW or --no-auto-map to change.`,
          );
          break;
        }
      }
    }
  }

  // Story identity + validation (no writes).
  const storyId = options.id ?? slugifyStoryId(path.basename(titleDir));
  const excludePatterns = options.excludePatterns ?? [...policy.defaultExcludePatterns];
  let prepared: Awaited<ReturnType<typeof prepareNewStory>> | null = null;
  try {
    prepared = await prepareNewStory(
      options.storiesRoot,
      {
        id: storyId,
        displayName: options.displayName,
        titleDir,
        excludePatterns,
        additionalExtensions: options.additionalExtensions,
        embeddingModelId: embedding.modelId ?? undefined,
        chunkSize: chunking.chunkSize,
        chunkOverlap: chunking.chunkOverlap,
      },
      policy,
    );
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  let fallbackStoryDir = path.join(path.resolve(options.storiesRoot), "stories", storyId);
  try {
    fallbackStoryDir = getStoryDir(options.storiesRoot, storyId);
  } catch {
    /* invalid id: already reported by prepareNewStory */
  }
  const storyDir = prepared?.storyDir ?? fallbackStoryDir;
  const indexDir = prepared?.story.indexDir ?? path.join(storyDir, "index");
  if (fs.existsSync(indexDir)) {
    errors.push(`Destination index folder already exists: ${indexDir}`);
  }
  if (isInside(indexDir, storeDir) || isInside(storeDir, indexDir) || path.resolve(indexDir) === storeDir) {
    errors.push(`Destination ${indexDir} overlaps the source store ${storeDir}.`);
  }

  // ---- First-reindex prediction (what the plugin will do with Skip Previously Indexed ON) ----
  const { additionalPlainTextSet } = resolveAdditionalExtensions((options.additionalExtensions ?? []).join("\n"));
  const scanned = await scanDirectory([titleDir], undefined, {
    excludePatterns,
    additionalPlainTextExtensions: additionalPlainTextSet,
  });
  const scannedSet = new Set(scanned.map((f) => path.resolve(f.path)));
  const files: FilePlanEntry[] = [];
  const inside = emptyCount();
  const outside = emptyCount();
  const excluded = emptyCount();
  const unchanged = emptyCount();
  const reEmbed = emptyCount();
  const prune = { files: 0, chunks: 0, byReason: { "outside-title-folder": 0, excluded: 0, "missing-on-disk": 0, "unsupported-type": 0 } as Record<PruneReason, number>, examples: [] as string[] };
  const knownAbs = new Set<string>();
  for (const [oldPath, info] of fileChunks) {
    const mappedPath = path.isAbsolute(oldPath) ? path.resolve(applyPathMaps(oldPath, pathMaps)) : oldPath;
    const storedPath = toStoredPath(mappedPath, titleDir);
    knownAbs.add(mappedPath);
    const isIn = isInside(mappedPath, titleDir);
    (isIn ? inside : outside).files++;
    (isIn ? inside : outside).chunks += info.chunks;
    let entry: FilePlanEntry;
    let reason: PruneReason | undefined;
    if (!isIn) reason = "outside-title-folder";
    else if (excludePatterns.some((p) => matchExcludePattern(storedPath, [p]))) reason = "excluded";
    else if (!fs.existsSync(mappedPath)) reason = "missing-on-disk";
    else if (!scannedSet.has(mappedPath)) reason = "unsupported-type";
    if (reason === "excluded") {
      excluded.files++;
      excluded.chunks += info.chunks;
    }
    if (reason) {
      entry = { oldPath, mappedPath, storedPath, fileHash: info.hash, chunks: info.chunks, firstReindex: "prune", pruneReason: reason };
      prune.files++;
      prune.chunks += info.chunks;
      prune.byReason[reason]++;
      if (prune.examples.length < 10) prune.examples.push(`${storedPath} (${reason})`);
    } else {
      const currentHash = await calculateFileHash(mappedPath);
      const same = currentHash === info.hash;
      entry = { oldPath, mappedPath, storedPath, fileHash: info.hash, chunks: info.chunks, firstReindex: same ? "unchanged" : "re-embed" };
      (same ? unchanged : reEmbed).files++;
      (same ? unchanged : reEmbed).chunks += info.chunks;
    }
    files.push(entry);
  }
  const newFiles = scanned.map((f) => path.resolve(f.path)).filter((p) => !knownAbs.has(p));
  const pruneNow = options.prune === true;
  const dropPaths = new Set(pruneNow ? files.filter((f) => f.firstReindex === "prune").map((f) => f.oldPath) : []);
  const chunksDropped = allItems.filter((i) => dropPaths.has(String(i.metadata?.filePath ?? ""))).length;

  if (prune.files > 0) {
    const verb = pruneNow ? "WILL BE DROPPED NOW (--prune)" : "will be PRUNED by the first reindex of this story";
    warnings.push(
      `⚠ ${prune.files} file(s) / ${prune.chunks} chunk(s) ${verb}: ` +
        Object.entries(prune.byReason).filter(([, n]) => n > 0).map(([r, n]) => `${n} ${r}`).join(", ") +
        `. Examples: ${prune.examples.slice(0, 5).join("; ")}` +
        (pruneNow ? "" : `. They stay searchable until then. If that's wrong, fix --path-map/--exclude or the title folder before reindexing.`),
    );
    if (outside.files > 0 && inside.files === 0) {
      errors.push(
        `None of the store's files are inside ${titleDir}` +
          (oldDocumentsFolder ? ` (they were under ${oldDocumentsFolder})` : "") +
          `. Wrong title folder? Use --path-map OLD=NEW if the documents moved.`,
      );
    }
  }
  if (reEmbed.files > 0) {
    warnings.push(`${reEmbed.files} file(s) changed since they were indexed; the first reindex re-embeds them (${reEmbed.chunks} old chunks replaced).`);
  }
  warnings.push(
    `The first reindex must run with "Skip Previously Indexed" ON (the default), otherwise every file is re-embedded.`,
  );

  const displayName = prepared?.manifest.displayName ?? options.displayName ?? storyId;
  const report: AdoptReport = {
    dryRun,
    mode: runMode,
    storeDir,
    titleDir,
    storyId,
    displayName,
    storyDir,
    indexDir,
    shards: shards.length,
    totalChunks: allItems.length,
    totalFiles: fileChunks.size,
    embedding,
    chunking,
    oldDocumentsFolder,
    oldTopFolders: [...topFolders.entries()].map(([folder, v]) => ({ folder, ...v })).sort((a, b) => b.chunks - a.chunks),
    pathMapsApplied: pathMaps,
    inside,
    outside,
    excluded: { ...excluded, patterns: excludePatterns },
    firstReindex: {
      unchanged,
      reEmbed,
      newFiles: { files: newFiles.length, examples: newFiles.slice(0, 10).map((p) => toStoredPath(p, titleDir)) },
      prune,
    },
    pruneNow,
    chunksAdopted: allItems.length - chunksDropped,
    chunksDropped,
    files,
    warnings,
    errors,
  };

  if (dryRun) return report;
  if (errors.length > 0 || !prepared || !embedding.modelId) {
    throw new AdoptStoreError(`Refusing to adopt:\n- ${errors.join("\n- ")}`);
  }

  // ---- 3. Copy / move -----------------------------------------------------------------------
  const originalVectors = new Map(allItems.map((i) => [i.id, JSON.stringify(i.vector)]));
  const storyDirExisted = fs.existsSync(storyDir);
  await fsp.mkdir(storyDir, { recursive: true });
  try {
    if (runMode === "move") {
      try {
        await fsp.rename(storeDir, indexDir);
      } catch (e: any) {
        if (e?.code !== "EXDEV") throw e;
        await fsp.cp(storeDir, indexDir, { recursive: true, errorOnExist: true, force: false });
        await fsp.rm(storeDir, { recursive: true, force: true });
      }
      // Keep only shards + embedding manifest in the index folder.
      const failures = path.join(indexDir, STORY_FAILURES_FILENAME);
      if (fs.existsSync(failures)) await fsp.rename(failures, path.join(storyDir, STORY_FAILURES_FILENAME));
    } else {
      await fsp.mkdir(indexDir, { recursive: true });
      for (const s of shards) {
        await fsp.cp(path.join(storeDir, s.name), path.join(indexDir, s.name), { recursive: true, errorOnExist: true, force: false });
      }
      const failures = path.join(storeDir, STORY_FAILURES_FILENAME);
      if (fs.existsSync(failures)) await fsp.copyFile(failures, path.join(storyDir, STORY_FAILURES_FILENAME));
    }

    // ---- 4. Rewrite ids + metadata in place (vectors untouched) -----------------------------
    const mappedByOld = new Map(files.map((f) => [f.oldPath, f]));
    let written = 0;
    for (const s of shards) {
      const file = path.join(indexDir, s.name, "index.json");
      const json = JSON.parse(await fsp.readFile(file, "utf-8"));
      json.items = (json.items as RawItem[])
        .filter((item) => !dropPaths.has(String(item.metadata?.filePath ?? "")))
        .map((item) => {
          const plan = mappedByOld.get(String(item.metadata?.filePath ?? ""));
          const storedPath = plan ? plan.storedPath : String(item.metadata?.filePath ?? "");
          const subfolder = subfolderOf(storedPath);
          const metadata: Record<string, any> = { ...item.metadata, filePath: storedPath, storyId };
          if (subfolder) metadata.subfolder = subfolder;
          else delete metadata.subfolder;
          return {
            ...item,
            id: item.id.startsWith(`${storyId}:`) ? item.id : `${storyId}:${item.id}`,
            metadata,
          };
        });
      written += json.items.length;
      // Compact JSON like vectra writes it (pretty-printing 768-dim vectors would bloat shards).
      const tmp = `${file}.${process.pid}.adopt.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(json), "utf-8");
      await fsp.rename(tmp, file);
    }

    // ---- 5. Verify --------------------------------------------------------------------------
    let verified = 0;
    for (const s of shards) {
      const json = JSON.parse(await fsp.readFile(path.join(indexDir, s.name, "index.json"), "utf-8"));
      for (const item of json.items as RawItem[]) {
        const oldId = item.id.slice(storyId.length + 1);
        if (item.metadata?.storyId !== storyId) throw new AdoptStoreError(`Verification failed: unstamped chunk ${item.id}`);
        if (originalVectors.get(oldId) !== JSON.stringify(item.vector)) {
          throw new AdoptStoreError(`Verification failed: vector changed for chunk ${item.id}`);
        }
        verified++;
      }
    }
    if (verified !== written || verified !== report.chunksAdopted) {
      throw new AdoptStoreError(`Verification failed: expected ${report.chunksAdopted} chunks, found ${verified}`);
    }

    // ---- 6. Embedding manifest, then story.json last -----------------------------------------
    await writeJsonAtomic(path.join(indexDir, EMBEDDING_INDEX_MANIFEST_FILENAME), {
      embeddingModelId: embedding.modelId,
      dimensions: embedding.dimensions,
    });
    const keptHashes = new Set(
      allItems.filter((i) => !dropPaths.has(String(i.metadata?.filePath ?? ""))).map((i) => String(i.metadata?.fileHash ?? "")),
    );
    const finalManifest: StoryManifest = {
      ...prepared.manifest,
      embedding: { modelId: embedding.modelId, dimensions: embedding.dimensions },
      stats: { totalChunks: verified, uniqueFiles: keptHashes.size, lastIndexedAt: null },
      migration: {
        sourceStore: storeDir,
        migratedAt: new Date().toISOString(),
        mode: runMode,
        chunkingSource: chunking.source,
        embeddingSource: embedding.source === "flag" ? "flag" : "manifest",
        chunksAdopted: verified,
        chunksDropped,
      },
    };
    await writeJsonAtomic(prepared.manifestPath, finalManifest);
  } catch (e) {
    if (runMode === "copy" && !storyDirExisted) {
      // Our own partial copy; the original store was never touched.
      await fsp.rm(storyDir, { recursive: true, force: true }).catch(() => undefined);
    } else if (runMode === "move") {
      (e as Error).message += `\nThe store was moved to ${indexDir} (no story.json written). Move it back or fix and rerun.`;
    }
    throw e;
  }
  return report;
}

/** Human-readable report for the CLI. */
export function formatAdoptReport(r: AdoptReport): string {
  const L: string[] = [];
  const n = (c: { files: number; chunks: number }) => `${c.files} files / ${c.chunks} chunks`;
  L.push(r.dryRun ? "=== adopt-store DRY RUN (nothing written) ===" : "=== adopt-store ===");
  L.push(`Old store:        ${r.storeDir}  (${r.shards} shard(s), ${r.totalChunks} chunks, ${r.totalFiles} files)`);
  L.push(`Title folder:     ${r.titleDir}`);
  L.push(`New story:        ${r.storyId} ("${r.displayName}") -> ${r.storyDir}`);
  L.push(`Mode:             ${r.mode === "move" ? "MOVE (original store folder will be moved)" : "copy (original store untouched)"}`);
  L.push("");
  L.push("Detected settings:");
  L.push(`  Embedding model: ${r.embedding.modelId ?? "UNKNOWN (pass --model)"}  [${r.embedding.source}]`);
  L.push(`  Dimensions:      ${r.embedding.dimensions}  [from vectors]`);
  L.push(
    `  Chunk size/overlap: ${r.chunking.chunkSize}/${r.chunking.chunkOverlap}  [${r.chunking.source}` +
      (r.chunking.evidence ? `, ${r.chunking.evidence.agreeing}/${r.chunking.evidence.sampled} files agree` : "") + "]",
  );
  L.push(`  Old documents folder: ${r.oldDocumentsFolder ?? "unknown"}`);
  for (const t of r.oldTopFolders.slice(0, 12)) L.push(`    ${t.folder}: ${t.files} files / ${t.chunks} chunks`);
  for (const m of r.pathMapsApplied) L.push(`  Path map: ${m.from} -> ${m.to}`);
  L.push("");
  L.push(`Inside title folder:  ${n(r.inside)}`);
  L.push(`Outside title folder: ${n(r.outside)}`);
  L.push(`Excluded by patterns (${r.excluded.patterns.join(", ") || "none"}): ${n(r.excluded)}`);
  L.push("");
  L.push(`First reindex of this story (Skip Previously Indexed ON):`);
  L.push(`  skip (unchanged): ${n(r.firstReindex.unchanged)}`);
  L.push(`  re-embed (changed): ${n(r.firstReindex.reEmbed)}`);
  L.push(`  embed (new files): ${r.firstReindex.newFiles.files}${r.firstReindex.newFiles.examples.length ? ` e.g. ${r.firstReindex.newFiles.examples.slice(0, 5).join(", ")}` : ""}`);
  L.push(`  prune: ${n(r.firstReindex.prune)}${r.pruneNow ? "  (dropped now: --prune)" : ""}`);
  L.push("");
  L.push(`Chunks adopted: ${r.chunksAdopted}${r.chunksDropped ? `  (dropped ${r.chunksDropped})` : ""}`);
  if (r.warnings.length) {
    L.push("");
    L.push("Warnings:");
    for (const w of r.warnings) L.push(`  - ${w}`);
  }
  if (r.errors.length) {
    L.push("");
    L.push(r.dryRun ? "Would REFUSE to run:" : "Errors:");
    for (const e of r.errors) L.push(`  - ${e}`);
  }
  return L.join("\n");
}
