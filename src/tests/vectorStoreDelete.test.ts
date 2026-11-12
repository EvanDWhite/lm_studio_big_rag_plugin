import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VectorStore } from "../vectorstore/vectorStore";
import { fakeVector } from "./helpers/fakeLmStudio";

/** Regression: deletes on the active shard must not be undone by the next add (stale vectra cache). */
test("deleted chunks stay deleted after a later addChunks on the same shard", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bigrag-vsdel-"));
  try {
    const chunk = (file: string, hash: string) => ({
      id: `${hash}-0`, text: file, vector: fakeVector(file), filePath: file, fileName: file, fileHash: hash, chunkIndex: 0, metadata: {},
    });
    const store = new VectorStore(dir);
    await store.initialize();
    await store.addChunks([chunk("a.md", "ha"), chunk("b.md", "hb")]);
    await store.close();

    const reopened = new VectorStore(dir);
    await reopened.initialize();
    await reopened.deleteByFilePath("a.md");
    await reopened.deleteOrphanChunksForFilePath("b.md", "other-hash");
    await reopened.addChunks([chunk("c.md", "hc")]);
    const files = (await reopened.listChunks()).map((c) => c.metadata.filePath).sort();
    await reopened.close();
    assert.deepEqual(files, ["c.md"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
