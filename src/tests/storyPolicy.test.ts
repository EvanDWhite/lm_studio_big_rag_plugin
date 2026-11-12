import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_STORY_POLICY, getStoryPolicy, type StoryPolicy } from "../stories/policy";
import { resolveStoryTarget } from "../stories/resolveStoryTarget";
import { createStory } from "../stories/storyRegistry";
import { isolateHome } from "./helpers/fakeLmStudio";

/** Each open decision is one knob in stories/policy.ts; these tests pin defaults and show flipping works. */

let base = "";
let storiesRoot = "";
let restoreHome: () => void = () => undefined;
const reader = (values: Record<string, unknown>) => ({ get: (k: string) => values[k] });
const policy = (overrides: Partial<StoryPolicy>): StoryPolicy => ({ ...DEFAULT_STORY_POLICY, ...overrides });

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "big-rag-policy-"));
  restoreHome = isolateHome(base);
  storiesRoot = path.join(base, "library");
  for (const name of ["Alpha", "Beta"]) fs.mkdirSync(path.join(base, "titles", name), { recursive: true });
  await createStory(storiesRoot, { titleDir: path.join(base, "titles", "Alpha") });
  await createStory(storiesRoot, { titleDir: path.join(base, "titles", "Beta") });
});
after(() => {
  restoreHome();
  fs.rmSync(base, { recursive: true, force: true });
});

test("defaults: tool arg only when chat has none; no override; overlaps rejected; nested chapter_raw excluded", () => {
  assert.deepEqual(getStoryPolicy(), {
    allowToolStoryArgWhenChatHasNone: true,
    allowToolStoryArgOverride: false,
    rejectOverlappingSources: true,
    defaultExcludePatterns: ["**/chapter_raw/**"],
    maxPruneFraction: 0.5,
  });
});

test("allowToolStoryArgWhenChatHasNone=false refuses REST story selection", async () => {
  const global = reader({ storiesRoot });
  const allowed = await resolveStoryTarget({ chat: reader({}), global, explicitStoryId: "beta" });
  assert.ok(allowed.ok && allowed.source === "tool-argument");
  const refused = await resolveStoryTarget({
    chat: reader({}),
    global,
    explicitStoryId: "beta",
    policy: policy({ allowToolStoryArgWhenChatHasNone: false }),
  });
  assert.equal(!refused.ok && refused.reason, "tool-arg-disabled");
});

test("allowToolStoryArgOverride=true lets a bound chat's tool call pick another story", async () => {
  const global = reader({ storiesRoot });
  const chat = reader({ story: "alpha" });
  const refused = await resolveStoryTarget({ chat, global, explicitStoryId: "beta" });
  assert.equal(!refused.ok && refused.reason, "story-mismatch");
  const allowed = await resolveStoryTarget({
    chat,
    global,
    explicitStoryId: "beta",
    policy: policy({ allowToolStoryArgOverride: true }),
  });
  assert.ok(allowed.ok && allowed.story.id === "beta" && allowed.source === "tool-argument");
});

test("rejectOverlappingSources=false allows shared folders (each story still stamps its own chunks)", async () => {
  const nested = path.join(base, "titles", "Alpha", "shared");
  fs.mkdirSync(nested, { recursive: true });
  await assert.rejects(createStory(storiesRoot, { id: "shared", titleDir: nested }), /overlaps/);
  const story = await createStory(storiesRoot, { id: "shared", titleDir: nested }, policy({ rejectOverlappingSources: false }));
  assert.equal(story.chunkStamp, "shared");
});

test("defaultExcludePatterns applies to new stories only", async () => {
  fs.mkdirSync(path.join(base, "titles", "Gamma"), { recursive: true });
  const story = await createStory(
    storiesRoot,
    { titleDir: path.join(base, "titles", "Gamma") },
    policy({ defaultExcludePatterns: ["chapter_raw/**"] }),
  );
  assert.deepEqual(story.excludePatterns, ["chapter_raw/**"]);
  const manifest = JSON.parse(fs.readFileSync(story.manifestPath!, "utf-8"));
  assert.deepEqual(manifest.excludePatterns, ["chapter_raw/**"], "written explicitly into story.json");
});
