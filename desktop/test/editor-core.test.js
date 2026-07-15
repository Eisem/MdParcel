import test from "node:test";
import assert from "node:assert/strict";
import {
  createDocument,
  displayTitle,
  findMatches,
  isDocumentDirty,
  markdownImage,
  replaceAllLiteral,
} from "../src/editor-core.js";

test("new documents remain dirty until their initial content is saved", () => {
  const document = createDocument({ title: "草稿", markdown: "# 草稿" });
  assert.equal(isDocumentDirty(document), true);
  document.savedTitle = document.title;
  document.savedMarkdown = document.markdown;
  assert.equal(isDocumentDirty(document), false);
});

test("opened documents start clean and expose a fallback title", () => {
  const document = createDocument({ title: "", markdown: "hello" }, "C:/note.mdparcel");
  assert.equal(isDocumentDirty(document), false);
  assert.equal(displayTitle(document), "未命名文档");
});

test("find and replace supports case-sensitive and insensitive matching", () => {
  assert.deepEqual(findMatches("One one ONE", "one").map((item) => item.start), [0, 4, 8]);
  assert.deepEqual(findMatches("One one ONE", "one", true).map((item) => item.start), [4]);
  assert.deepEqual(replaceAllLiteral("a.b A.B", "a.b", "x"), { text: "x x", count: 2 });
});

test("Markdown image alt text cannot break its brackets", () => {
  assert.equal(markdownImage("assets/photo.png", "[封面]"), "![封面](assets/photo.png)");
});
