import * as path from "path";

/**
 * Per-store indexing locks, keyed by the resolved index directory, so indexing story A never
 * blocks (or is confused with) indexing story B, while two chats on the same story still
 * cannot index it at the same time. In-process only.
 */
const locksHeld = new Map<string, string>();

function lockKey(indexDir: string): string {
  return path.resolve(indexDir);
}

/** Try to take the lock for one store. Returns false if that store is already being indexed. */
export function tryStartIndexing(indexDir: string, context: string = "unknown"): boolean {
  const key = lockKey(indexDir);
  const holder = locksHeld.get(key);
  if (holder !== undefined) {
    console.debug(`[BigRAG] tryStartIndexing (${context}) failed for ${key}: held by ${holder}`);
    return false;
  }
  locksHeld.set(key, context);
  console.debug(`[BigRAG] tryStartIndexing (${context}) succeeded for ${key}`);
  return true;
}

/** Release the lock for one store. */
export function finishIndexing(indexDir: string): void {
  locksHeld.delete(lockKey(indexDir));
  console.debug(`[BigRAG] finishIndexing: lock released for ${lockKey(indexDir)}`);
}

/** Whether this store is currently being indexed. */
export function isIndexing(indexDir: string): boolean {
  return locksHeld.has(lockKey(indexDir));
}
