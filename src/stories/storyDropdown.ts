import { PLUGIN_NAME } from "../identity";
import * as fs from "fs";
import { homedir } from "os";
import * as path from "path";
import { buildConfigSchematics, setActiveConfigSchematics, type BigRagConfigSchematics } from "../config";
import { listStories, resolveStoriesRoot, STORIES_ROOT_ENV } from "./storyRegistry";

/**
 * The per-chat story dropdown.
 *
 * SDK limits: select options are fixed when the schematics are built, schematics are registered
 * once in main(), and main() has no access to the GLOBAL plugin config (only controllers do). So:
 *  - at startup we list stories under $BIG_RAG_STORIES_ROOT, else the root last seen in a chat
 *    (a hint file, written by the preprocessor), else the default root;
 *  - the dropdown is only a convenience list. Every chat still resolves and validates its story
 *    against the CURRENT global Stories Root; the hint never decides what gets searched.
 */

/** Plugin-specific name (upstream Big RAG has no such file), so no cross-plugin sharing. */
export const STORIES_ROOT_HINT_FILENAME = `${PLUGIN_NAME}-root-hint.json`;

export interface DropdownState {
  /** Root the dropdown options were listed from. */
  storiesRoot: string;
  storyIds: string[];
  builtAt: string;
}

let dropdownState: DropdownState | null = null;

export function getDropdownState(): DropdownState | null {
  return dropdownState;
}

function hintPath(): string {
  return path.join(homedir(), ".lmstudio", STORIES_ROOT_HINT_FILENAME);
}

export function readStoriesRootHint(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(hintPath(), "utf-8")) as { storiesRoot?: unknown };
    return typeof parsed.storiesRoot === "string" && parsed.storiesRoot.trim() ? parsed.storiesRoot : null;
  } catch {
    return null;
  }
}

/** Remember the root a chat actually used, so the next startup lists the right stories. */
export function writeStoriesRootHint(storiesRoot: string): void {
  try {
    if (readStoriesRootHint() === storiesRoot) return;
    fs.mkdirSync(path.dirname(hintPath()), { recursive: true });
    fs.writeFileSync(hintPath(), `${JSON.stringify({ storiesRoot }, null, 2)}\n`, "utf-8");
  } catch (error) {
    console.warn("[BigRAG-Stories] Could not write stories root hint:", error);
  }
}

export function resolveStartupStoriesRoot(environment: NodeJS.ProcessEnv = process.env): string {
  if ((environment[STORIES_ROOT_ENV] ?? "").trim()) return resolveStoriesRoot("", environment);
  return resolveStoriesRoot(readStoriesRootHint() ?? "", environment);
}

/** Build + activate the schematics with one dropdown option per story. Never throws. */
export async function initStoryDropdown(storiesRoot: string = resolveStartupStoriesRoot()): Promise<BigRagConfigSchematics> {
  let options: Array<{ value: string; displayName: string }> = [];
  try {
    const stories = await listStories(storiesRoot);
    options = stories.map((s) => ({
      value: s.id,
      displayName: s.displayName === s.id ? s.id : `${s.displayName} (${s.id})`,
    }));
  } catch (error) {
    console.warn(`[BigRAG-Stories] Could not list stories under ${storiesRoot}; dropdown has only "None".`, error);
  }
  const schematics = buildConfigSchematics(options);
  setActiveConfigSchematics(schematics);
  dropdownState = {
    storiesRoot,
    storyIds: options.map((o) => o.value),
    builtAt: new Date().toISOString(),
  };
  console.info(`[BigRAG-Stories] Story dropdown: ${options.length} stories from ${storiesRoot}`);
  return schematics;
}
