import { tool, type Tool, type ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { getIndexStatus, retrievePassages } from "./rag/retrieval";
import { readConfigReaders, resolveStoryTarget, type StoryTarget } from "./stories/resolveStoryTarget";

/**
 * Tools resolve their story exactly like the prompt preprocessor: from THIS chat's config (Story
 * ID, or both legacy path fields). A REST caller with no chat config must pass `story`
 * explicitly. There is no fallback to a synced "last used chat" file or env vars, and a tool
 * call can never switch a chat to a different story than the one it is bound to.
 */
async function resolveForTool(ctl: ToolsProviderController, story?: string): Promise<StoryTarget> {
  const { chat, global } = readConfigReaders(ctl);
  return resolveStoryTarget({ chat, global, explicitStoryId: story });
}

function targetError(target: Exclude<StoryTarget, { ok: true }>): string {
  if (target.reason === "not-configured") {
    return (
      "Error: No story selected. Set Story ID in this chat's Big RAG settings, or pass the `story` " +
      "argument (REST). No search was run."
    );
  }
  return `Error: ${target.message} No search was run.`;
}

const storyParam = z
  .string()
  .optional()
  .describe(
    "Story database id (REST only). In a chat, the chat's selected story is always used and a different id is refused.",
  );

export async function provideTools(ctl: ToolsProviderController): Promise<Tool[]> {
  const searchTool = tool({
    name: "big_rag_search",
    description:
      "Search the Big RAG story database selected for this chat for passages relevant to a query. " +
      "Returns matching text snippets with file names and similarity scores.",
    parameters: {
      query: z.string().describe("Natural-language search query"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum passages to return (defaults to plugin Retrieval Limit setting)"),
      story: storyParam,
    },
    implementation: async ({ query, limit, story }, { signal, status }) => {
      status("Searching indexed documents…");

      const trimmedQuery = query.trim();
      if (trimmedQuery.length === 0) {
        return "Error: Search query must not be empty.";
      }

      const target = await resolveForTool(ctl, story);
      if (!target.ok) {
        return targetError(target);
      }

      const { chat } = readConfigReaders(ctl);
      const configuredLimit = chat.get("retrievalLimit");
      const configuredThreshold = chat.get("retrievalAffinityThreshold");
      const retrievalLimit = limit ?? (typeof configuredLimit === "number" ? configuredLimit : 5);
      const retrievalThreshold = typeof configuredThreshold === "number" ? configuredThreshold : 0.5;

      const result = await retrievePassages({
        client: ctl.client,
        story: target.story,
        query: trimmedQuery,
        retrievalLimit,
        retrievalThreshold,
        abortSignal: signal,
      });

      if (!result.ok) {
        if (result.logMessage) {
          console.error("[BigRAG]", result.logMessage);
        }
        return `Error: ${result.message}`;
      }

      // Return a plain object — LM Studio serializes tool results once.
      type SearchPassageResult = {
        rank: number;
        fileName: string;
        filePath: string;
        score: number;
        shardName: string;
        text: string;
      };

      const searchPassages: SearchPassageResult[] = result.passages.map(
        (passage, passageIndex) => ({
          rank: passageIndex + 1,
          fileName: passage.fileName,
          filePath: passage.filePath,
          score: passage.score,
          shardName: passage.shardName,
          text: passage.text,
        }),
      );

      return {
        story: target.story.id,
        query: trimmedQuery,
        passageCount: searchPassages.length,
        passages: searchPassages,
        ...(searchPassages.length === 0
          ? { message: "No relevant content found in this story's indexed documents for this query." }
          : {}),
      };
    },
  });

  const statusTool = tool({
    name: "big_rag_index_status",
    description:
      "Return Big RAG index statistics for the story selected for this chat: chunk count, unique file count, and source folders.",
    parameters: {
      story: storyParam,
    },
    implementation: async ({ story }, { status }) => {
      status("Reading index status…");

      const target = await resolveForTool(ctl, story);
      if (!target.ok) {
        return targetError(target);
      }
      return getIndexStatus({ story: target.story });
    },
  });

  return [searchTool, statusTool];
}
