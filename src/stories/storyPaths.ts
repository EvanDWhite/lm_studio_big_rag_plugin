import * as path from "path";

/**
 * Chunk paths for stories are stored RELATIVE to the story's title folder (posix separators),
 * so an index survives moving the title folder and citations can show "characters/hero.md".
 * Legacy stores (no path base) and files outside the title folder keep absolute paths.
 */

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Absolute file path -> the form stored in chunk metadata. */
export function toStoredPath(absolutePath: string, pathBase: string | undefined): string {
  const resolved = path.resolve(absolutePath);
  if (!pathBase || !isInside(resolved, pathBase)) {
    return resolved;
  }
  return path.relative(pathBase, resolved).split(path.sep).join("/");
}

/** Stored chunk path -> absolute path on this machine. */
export function toAbsolutePath(storedPath: string, pathBase: string | undefined): string {
  if (path.isAbsolute(storedPath) || !pathBase) {
    return path.resolve(storedPath);
  }
  return path.resolve(pathBase, ...storedPath.split("/"));
}

/** First folder of a stored relative path ("characters/hero.md" -> "characters"), else undefined. */
export function subfolderOf(storedPath: string): string | undefined {
  if (path.isAbsolute(storedPath)) return undefined;
  const parts = storedPath.split("/");
  return parts.length > 1 ? parts[0] : undefined;
}
