import { type PluginContext } from "@lmstudio/sdk";
import { globalConfigSchematics } from "./config";
import { initStoryDropdown } from "./stories/storyDropdown";
import { preprocess } from "./promptPreprocessor";
import { provideTools } from "./toolsProvider";

/**
 * Main entry point for the Big RAG plugin.
 * This plugin indexes large document collections and provides RAG capabilities.
 */
export async function main(context: PluginContext) {
  // Per-chat schematics include a story dropdown listed once, here, at startup.
  context.withConfigSchematics(await initStoryDropdown());
  context.withGlobalConfigSchematics(globalConfigSchematics);
  
  // Register the prompt preprocessor
  context.withPromptPreprocessor(preprocess);

  // Register tools for REST API / agent integrations
  context.withToolsProvider(provideTools);
  
  console.log("[BigRAG] Plugin initialized successfully");
}

