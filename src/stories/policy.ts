/**
 * Story isolation policy: the open product decisions, in one place.
 *
 * Each knob is read through `getStoryPolicy()`, and every function that applies one also accepts an
 * explicit `policy` argument (tests use that). To change a default, edit DEFAULT_STORY_POLICY.
 */
export interface StoryPolicy {
  /**
   * A tool call may name a story with its `story` argument when the chat itself has NO story
   * (needed for REST, which has no chat config). If false, tools only ever use the chat's story,
   * so REST cannot search at all.
   */
  allowToolStoryArgWhenChatHasNone: boolean;
  /**
   * A tool call in a chat that IS bound to a story may name a *different* story. Keep false:
   * true lets the model hop between stories.
   */
  allowToolStoryArgOverride: boolean;
  /**
   * Reject creating a story whose source folders overlap (same, nested or containing) another
   * story's. If false, shared folders are allowed; each story still gets its own copy of the
   * chunks, stamped with its own id, so retrieval stays isolated.
   */
  rejectOverlappingSources: boolean;
  /**
   * Excludes applied to NEW stories (written explicitly into story.json, so changing this never
   * alters existing stories). Relative to each source root, minimatch syntax.
   * "**\/chapter_raw/**" excludes chapter_raw at any depth; use "chapter_raw/**" for top level only.
   */
  defaultExcludePatterns: readonly string[];
  /**
   * Safety brake for story reindexing: if more than this fraction of a story's indexed files would
   * be pruned in one run (and at least 4 files are indexed), pruning is SKIPPED and a warning is
   * shown instead (usually a wrong/unmounted title folder or a bad exclude). 1 disables the brake.
   */
  maxPruneFraction: number;
}

export const DEFAULT_STORY_POLICY: Readonly<StoryPolicy> = Object.freeze({
  allowToolStoryArgWhenChatHasNone: true,
  allowToolStoryArgOverride: false,
  rejectOverlappingSources: true,
  defaultExcludePatterns: Object.freeze(["**/chapter_raw/**"]),
  maxPruneFraction: 0.5,
});

export function getStoryPolicy(): Readonly<StoryPolicy> {
  return DEFAULT_STORY_POLICY;
}
