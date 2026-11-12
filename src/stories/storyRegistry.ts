import * as fs from "fs";
import * as fsp from "fs/promises";
import { createHash } from "crypto";
import { homedir } from "os";
import * as path from "path";
import { DEFAULT_EMBEDDING_MODEL_ID, resolveEmbeddingModelId } from "../config";
import { DEFAULT_STORY_POLICY, getStoryPolicy, type StoryPolicy } from "./policy";

/**
 * Story databases ("story DBs").
 *
 * Each story is one directory under `<storiesRoot>/stories/<storyId>/` holding:
 *   story.json               — per-story manifest (schema below)
 *   index/                   — Vectra shards for this story only (unless `indexDir` overrides)
 *   .big-rag-failures.json   — per-story failure registry
 *
 * Isolation is physical (separate directories) AND logical (every chunk written for a story is
 * stamped with `metadata.storyId`, and retrieval drops anything that does not match).
 */

export const STORY_MANIFEST_FILENAME = "story.json";
export const STORY_FAILURES_FILENAME = ".big-rag-failures.json";
export const STORY_SCHEMA_VERSION = 1;
export const STORIES_SUBDIR = "stories";
export const STORIES_ROOT_ENV = "BIG_RAG_STORIES_ROOT";
/** Default excludes for a new story (see policy.ts). */
export const DEFAULT_STORY_EXCLUDES: readonly string[] = DEFAULT_STORY_POLICY.defaultExcludePatterns;
export const DEFAULT_CHUNK_SIZE = 512;
export const DEFAULT_CHUNK_OVERLAP = 100;

const STORY_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface StoryManifest {
  schemaVersion: number;
  id: string;
  displayName: string;
  /** Title folder. Relative `sourceDirs` are resolved against it. */
  titleDir?: string;
  /** Roots to scan. Default ["."] = the whole title folder (every subfolder). */
  sourceDirs: string[];
  /** Globs relative to each source root (minimatch, same semantics as the chat setting). */
  excludePatterns: string[];
  additionalExtensions: string[];
  embedding: { modelId: string; dimensions: number | null };
  chunking: { chunkSize: number; chunkOverlap: number };
  enableOCR: boolean;
  /** Vector index location; relative to the story dir. Absolute = linked external store. */
  indexDir: string;
  /**
   * Migration aid: also accept chunks with no `storyId` stamp (e.g. a legacy single-DB store
   * linked via an absolute `indexDir`). The directory is still exclusive to this story.
   */
  acceptUnstampedChunks: boolean;
  stats: { totalChunks: number; uniqueFiles: number; lastIndexedAt: string | null };
  /** Set when the story was adopted from a legacy store (scripts: `adopt-store`). */
  migration?: StoryMigrationInfo;
}

export interface StoryMigrationInfo {
  sourceStore: string;
  migratedAt: string;
  mode: "copy" | "move";
  chunkingSource: "inferred" | "flag" | "default";
  embeddingSource: "manifest" | "flag";
  chunksAdopted: number;
  chunksDropped: number;
}

/** Everything indexing/retrieval needs, resolved to absolute paths. Passed explicitly everywhere. */
export interface StoryHandle {
  /** Story id, or `legacy:<hash>` for a chat that still uses the two legacy path fields. */
  id: string;
  kind: "story" | "legacy";
  displayName: string;
  /** Story dir (story) or the legacy vector store dir. */
  rootDir: string;
  indexDir: string;
  failureRegistryPath: string;
  sourceDirs: string[];
  excludePatterns: string[];
  additionalExtensions: string[];
  embeddingModelId: string;
  chunkSize: number;
  chunkOverlap: number;
  enableOCR: boolean;
  /** Stamp written into chunk metadata (`undefined` for legacy stores, which stay unstamped). */
  chunkStamp: string | undefined;
  acceptUnstampedChunks: boolean;
  /** Prune chunks for files no longer under the source dirs (stories only). */
  pruneMissingFiles: boolean;
  /** Chunk paths are stored relative to this folder (the title folder); undefined = absolute. */
  pathBase?: string;
  manifestPath?: string;
}

export type LoadStoryResult =
  | { ok: true; story: StoryHandle; manifest: StoryManifest }
  | { ok: false; reason: "invalid-id" | "not-found" | "invalid-manifest"; message: string };

export function resolveStoriesRoot(
  configured: string | undefined | null,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const fromConfig = (configured ?? "").trim();
  if (fromConfig) return path.resolve(expandHome(fromConfig));
  const fromEnv = (environment[STORIES_ROOT_ENV] ?? "").trim();
  if (fromEnv) return path.resolve(expandHome(fromEnv));
  return path.join(homedir(), ".lmstudio", "big-rag-stories");
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(homedir(), p.slice(1)) : p;
}

export function isValidStoryId(id: string): boolean {
  return STORY_ID_REGEX.test(id);
}

/** Slug a folder name into a story id ("The Salt Kingdom" -> "the-salt-kingdom"). */
export function slugifyStoryId(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);
  return slug || "story";
}

/** Absolute story directory, guarded against traversal outside `<root>/stories`. */
export function getStoryDir(storiesRoot: string, storyId: string): string {
  if (!isValidStoryId(storyId)) {
    throw new Error(`Invalid story id "${storyId}" (use lowercase letters, digits, - or _).`);
  }
  const base = path.resolve(storiesRoot, STORIES_SUBDIR);
  const dir = path.resolve(base, storyId);
  if (path.dirname(dir) !== base) {
    throw new Error(`Story id "${storyId}" resolves outside the stories root.`);
  }
  return dir;
}

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  await fsp.rename(tmp, filePath);
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") return null;
    if (v.trim()) out.push(v.trim());
  }
  return out;
}

function asPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Validate + fill defaults. Returns an error string on invalid input. */
export function normalizeStoryManifest(raw: unknown, expectedId: string): StoryManifest | string {
  if (typeof raw !== "object" || raw === null) return "story.json is not an object";
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== undefined && r.schemaVersion !== STORY_SCHEMA_VERSION) {
    return `unsupported schemaVersion ${String(r.schemaVersion)}`;
  }
  if (r.id !== expectedId) return `id "${String(r.id)}" does not match folder "${expectedId}"`;
  const titleDir = typeof r.titleDir === "string" && r.titleDir.trim() ? r.titleDir.trim() : undefined;
  const sourceDirs = r.sourceDirs === undefined ? (titleDir ? ["."] : []) : asStringArray(r.sourceDirs);
  if (sourceDirs === null) return "sourceDirs must be an array of strings";
  if (sourceDirs.length === 0) return "no sourceDirs and no titleDir";
  if (!titleDir && sourceDirs.some((d) => !path.isAbsolute(d))) {
    return "relative sourceDirs require titleDir";
  }
  const excludePatterns =
    r.excludePatterns === undefined ? [...DEFAULT_STORY_EXCLUDES] : asStringArray(r.excludePatterns);
  if (excludePatterns === null) return "excludePatterns must be an array of strings";
  const additionalExtensions =
    r.additionalExtensions === undefined ? [] : asStringArray(r.additionalExtensions);
  if (additionalExtensions === null) return "additionalExtensions must be an array of strings";
  const embedding = (r.embedding ?? {}) as Record<string, unknown>;
  const chunking = (r.chunking ?? {}) as Record<string, unknown>;
  const stats = (r.stats ?? {}) as Record<string, unknown>;
  const chunkSize = asPositiveInt(chunking.chunkSize, DEFAULT_CHUNK_SIZE);
  const chunkOverlap = asPositiveInt(chunking.chunkOverlap, DEFAULT_CHUNK_OVERLAP);
  if (chunkSize < 1) return "chunking.chunkSize must be >= 1";
  if (chunkOverlap >= chunkSize) return "chunking.chunkOverlap must be smaller than chunkSize";
  return {
    schemaVersion: STORY_SCHEMA_VERSION,
    id: expectedId,
    displayName: typeof r.displayName === "string" && r.displayName.trim() ? r.displayName.trim() : expectedId,
    titleDir,
    sourceDirs,
    excludePatterns,
    additionalExtensions,
    embedding: {
      modelId: resolveEmbeddingModelId(typeof embedding.modelId === "string" ? embedding.modelId : undefined),
      dimensions:
        typeof embedding.dimensions === "number" && embedding.dimensions > 0 ? embedding.dimensions : null,
    },
    chunking: { chunkSize, chunkOverlap },
    enableOCR: r.enableOCR === true,
    indexDir: typeof r.indexDir === "string" && r.indexDir.trim() ? r.indexDir.trim() : "index",
    acceptUnstampedChunks: r.acceptUnstampedChunks === true,
    stats: {
      totalChunks: asPositiveInt(stats.totalChunks, 0),
      uniqueFiles: asPositiveInt(stats.uniqueFiles, 0),
      lastIndexedAt: typeof stats.lastIndexedAt === "string" ? stats.lastIndexedAt : null,
    },
    ...(typeof r.migration === "object" && r.migration !== null
      ? { migration: r.migration as StoryMigrationInfo }
      : {}),
  };
}

export function storyHandleFromManifest(storyDir: string, manifest: StoryManifest): StoryHandle {
  const base = manifest.titleDir ? path.resolve(expandHome(manifest.titleDir)) : undefined;
  const sourceDirs = manifest.sourceDirs.map((d) =>
    path.isAbsolute(expandHome(d)) ? path.resolve(expandHome(d)) : path.resolve(base!, d),
  );
  const indexDir = path.isAbsolute(expandHome(manifest.indexDir))
    ? path.resolve(expandHome(manifest.indexDir))
    : path.resolve(storyDir, manifest.indexDir);
  return {
    id: manifest.id,
    kind: "story",
    displayName: manifest.displayName,
    rootDir: storyDir,
    indexDir,
    failureRegistryPath: path.join(storyDir, STORY_FAILURES_FILENAME),
    sourceDirs,
    excludePatterns: [...manifest.excludePatterns],
    additionalExtensions: [...manifest.additionalExtensions],
    embeddingModelId: manifest.embedding.modelId,
    chunkSize: manifest.chunking.chunkSize,
    chunkOverlap: manifest.chunking.chunkOverlap,
    enableOCR: manifest.enableOCR,
    chunkStamp: manifest.id,
    acceptUnstampedChunks: manifest.acceptUnstampedChunks,
    pruneMissingFiles: true,
    pathBase: base,
    manifestPath: path.join(storyDir, STORY_MANIFEST_FILENAME),
  };
}

export async function loadStory(storiesRoot: string, storyId: string): Promise<LoadStoryResult> {
  const id = storyId.trim();
  if (!isValidStoryId(id)) {
    return {
      ok: false,
      reason: "invalid-id",
      message: `Story id "${storyId}" is not valid (lowercase letters, digits, - and _ only).`,
    };
  }
  const storyDir = getStoryDir(storiesRoot, id);
  const manifestPath = path.join(storyDir, STORY_MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath, "utf-8");
  } catch {
    return { ok: false, reason: "not-found", message: `Story "${id}" not found (no ${manifestPath}).` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: "invalid-manifest", message: `Story "${id}": story.json is not valid JSON.` };
  }
  const manifest = normalizeStoryManifest(parsed, id);
  if (typeof manifest === "string") {
    return { ok: false, reason: "invalid-manifest", message: `Story "${id}": ${manifest}.` };
  }
  return { ok: true, story: storyHandleFromManifest(storyDir, manifest), manifest };
}

export interface CreateStoryOptions {
  id?: string;
  displayName?: string;
  titleDir?: string;
  sourceDirs?: string[];
  excludePatterns?: string[];
  additionalExtensions?: string[];
  embeddingModelId?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  enableOCR?: boolean;
  indexDir?: string;
  acceptUnstampedChunks?: boolean;
}

/** Create a new story (fails if it already exists). */
export async function createStory(
  storiesRoot: string,
  options: CreateStoryOptions,
  policy: Readonly<StoryPolicy> = getStoryPolicy(),
): Promise<StoryHandle> {
  const prepared = await prepareNewStory(storiesRoot, options, policy);
  await writeJsonAtomic(prepared.manifestPath, prepared.manifest);
  return prepared.story;
}

export interface PreparedStory {
  storyDir: string;
  manifestPath: string;
  manifest: StoryManifest;
  story: StoryHandle;
}

/**
 * Validate a new story (id, no existing story, no overlap per policy) and build its manifest
 * without writing anything.
 */
export async function prepareNewStory(
  storiesRoot: string,
  options: CreateStoryOptions,
  policy: Readonly<StoryPolicy> = getStoryPolicy(),
): Promise<PreparedStory> {
  const id = options.id ?? (options.titleDir ? slugifyStoryId(path.basename(path.resolve(options.titleDir))) : "");
  const storyDir = getStoryDir(storiesRoot, id);
  const manifestPath = path.join(storyDir, STORY_MANIFEST_FILENAME);
  if (fs.existsSync(manifestPath)) {
    throw new Error(`Story "${id}" already exists at ${storyDir}.`);
  }
  const draft = {
    schemaVersion: STORY_SCHEMA_VERSION,
    id,
    displayName: options.displayName ?? (options.titleDir ? path.basename(path.resolve(options.titleDir)) : id),
    titleDir: options.titleDir ? path.resolve(options.titleDir) : undefined,
    sourceDirs: options.sourceDirs,
    excludePatterns: options.excludePatterns ?? [...policy.defaultExcludePatterns],
    additionalExtensions: options.additionalExtensions,
    embedding: { modelId: options.embeddingModelId ?? DEFAULT_EMBEDDING_MODEL_ID, dimensions: null },
    chunking: {
      chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
      chunkOverlap: options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP,
    },
    enableOCR: options.enableOCR ?? false,
    indexDir: options.indexDir,
    acceptUnstampedChunks: options.acceptUnstampedChunks ?? false,
  };
  const manifest = normalizeStoryManifest(draft, id);
  if (typeof manifest === "string") {
    throw new Error(`Cannot create story "${id}": ${manifest}.`);
  }
  const story = storyHandleFromManifest(storyDir, manifest);
  if (policy.rejectOverlappingSources) {
    await assertNoTitleOverlap(storiesRoot, id, story.sourceDirs);
  }
  return { storyDir, manifestPath, manifest, story };
}

export async function listStories(storiesRoot: string): Promise<StoryHandle[]> {
  const base = path.join(storiesRoot, STORIES_SUBDIR);
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: StoryHandle[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isValidStoryId(e.name)) continue;
    const loaded = await loadStory(storiesRoot, e.name);
    if (loaded.ok) out.push(loaded.story);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Reject a story whose source folders overlap another story's (shared files would cross stories). */
async function assertNoTitleOverlap(storiesRoot: string, id: string, sourceDirs: string[]): Promise<void> {
  for (const other of await listStories(storiesRoot)) {
    if (other.id === id) continue;
    for (const mine of sourceDirs) {
      for (const theirs of other.sourceDirs) {
        if (isSameOrInside(mine, theirs) || isSameOrInside(theirs, mine)) {
          throw new Error(`Source folder ${mine} overlaps story "${other.id}" (${theirs}).`);
        }
      }
    }
  }
}

/** Record stats / embedding dimensions after an indexing run. */
export async function updateStoryAfterIndexing(
  story: StoryHandle,
  update: { totalChunks: number; uniqueFiles: number; dimensions: number | null },
): Promise<void> {
  if (story.kind !== "story" || !story.manifestPath) return;
  const raw = JSON.parse(await fsp.readFile(story.manifestPath, "utf-8"));
  const manifest = normalizeStoryManifest(raw, story.id);
  if (typeof manifest === "string") throw new Error(`Story "${story.id}": ${manifest}`);
  manifest.stats = {
    totalChunks: update.totalChunks,
    uniqueFiles: update.uniqueFiles,
    lastIndexedAt: new Date().toISOString(),
  };
  manifest.embedding.dimensions = update.totalChunks > 0 ? update.dimensions : null;
  await writeJsonAtomic(story.manifestPath, manifest);
}

export interface LegacyStoryInput {
  documentsDirs: string[];
  vectorStoreDir: string;
  embeddingModelId: string;
  chunkSize: number;
  chunkOverlap: number;
  enableOCR: boolean;
  excludePatterns: string[];
  additionalExtensions: string[];
}

/**
 * Handle for a chat that still uses the legacy Documents Directory + Vector Store Directory
 * fields. Behaves exactly like the pre-story plugin: chunks stay unstamped, no pruning, failure
 * log next to the shards. Isolation is by directory.
 */
export function legacyStoryHandle(input: LegacyStoryInput): StoryHandle {
  const indexDir = path.resolve(input.vectorStoreDir);
  const hash = createHash("sha256").update(indexDir).digest("hex").slice(0, 12);
  return {
    id: `legacy:${hash}`,
    kind: "legacy",
    displayName: `Legacy store ${indexDir}`,
    rootDir: indexDir,
    indexDir,
    failureRegistryPath: path.join(indexDir, STORY_FAILURES_FILENAME),
    sourceDirs: input.documentsDirs.map((d) => path.resolve(d)),
    excludePatterns: [...input.excludePatterns],
    additionalExtensions: [...input.additionalExtensions],
    embeddingModelId: resolveEmbeddingModelId(input.embeddingModelId),
    chunkSize: input.chunkSize,
    chunkOverlap: input.chunkOverlap,
    enableOCR: input.enableOCR,
    chunkStamp: undefined,
    acceptUnstampedChunks: true,
    pruneMissingFiles: false,
  };
}

/** True if a stored chunk belongs to this story. */
export function chunkBelongsToStory(metadata: Record<string, unknown> | undefined, story: StoryHandle): boolean {
  const stamp = metadata?.storyId;
  if (stamp === undefined || stamp === null || stamp === "") {
    return story.acceptUnstampedChunks;
  }
  return story.chunkStamp !== undefined && stamp === story.chunkStamp;
}
