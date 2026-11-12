import * as fs from "fs";
import * as path from "path";
import { parseExcludePatternsBlock } from "../utils/fileExcludePatterns";
import { getStoryPolicy, type StoryPolicy } from "./policy";
import { type ConfigReader } from "./resolveStoryTarget";
import { createStory, isValidStoryId, loadStory, slugifyStoryId, type StoryHandle } from "./storyRegistry";

export type CreateFromChatResult =
  | { status: "not-requested" }
  | { status: "created"; story: StoryHandle }
  | { status: "exists"; story: StoryHandle }
  | { status: "error"; message: string };

function str(chat: ConfigReader, key: string): string {
  const v = chat.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/**
 * "Create story from title folder" chat toggle. Idempotent: while the toggle stays ON, later
 * messages report that the story already exists instead of failing. Only ever writes under
 * `<storiesRoot>/stories/<id>/`; it never selects the story for the chat (the SDK cannot write
 * chat config), the user does that.
 */
export async function handleCreateStoryFromChat(
  chat: ConfigReader,
  storiesRoot: string,
  policy: Readonly<StoryPolicy> = getStoryPolicy(),
): Promise<CreateFromChatResult> {
  if (chat.get("newStory.create") !== true) {
    return { status: "not-requested" };
  }
  const titleDirRaw = str(chat, "newStory.titleDir");
  if (!titleDirRaw) {
    return { status: "error", message: "Create story: fill in 'New story: title folder' first." };
  }
  const titleDir = path.resolve(titleDirRaw);
  let isDir = false;
  try {
    isDir = fs.statSync(titleDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return { status: "error", message: `Create story: title folder not found: ${titleDir}` };
  }

  const id = str(chat, "newStory.id") || slugifyStoryId(path.basename(titleDir));
  if (!isValidStoryId(id)) {
    return { status: "error", message: `Create story: "${id}" is not a valid id (lowercase letters, digits, - and _).` };
  }

  const existing = await loadStory(storiesRoot, id);
  if (existing.ok) {
    const sameTitle = existing.manifest.titleDir && path.resolve(existing.manifest.titleDir) === titleDir;
    return sameTitle
      ? { status: "exists", story: existing.story }
      : { status: "error", message: `Create story: id "${id}" is already used by another title folder.` };
  }
  if (existing.reason === "invalid-manifest") {
    return { status: "error", message: `Create story: ${existing.message}` };
  }

  const excludes = parseExcludePatternsBlock(str(chat, "newStory.excludePatterns"));
  try {
    const story = await createStory(
      storiesRoot,
      {
        id,
        titleDir,
        excludePatterns: excludes.length > 0 ? excludes : undefined,
        embeddingModelId: str(chat, "newStory.embeddingModel") || undefined,
      },
      policy,
    );
    return { status: "created", story };
  } catch (error) {
    return { status: "error", message: `Create story: ${error instanceof Error ? error.message : String(error)}` };
  }
}
