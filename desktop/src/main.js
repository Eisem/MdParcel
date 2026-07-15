import { invoke } from "@tauri-apps/api/core";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";

const editor = document.getElementById("markdown-editor");
const titleInput = document.getElementById("document-title");
const preview = document.getElementById("preview");
const editorShell = document.getElementById("editor-shell");
const sidebar = document.getElementById("sidebar");

const state = {
  path: null,
  title: "未命名文档",
  markdown: "# 未命名文档\n\n开始编写你的 Markdown 文档。\n",
  assetCount: 0,
  dirty: true,
  mode: "split",
  renderVersion: 0,
};

const previewDocument = (html) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  :root{color:#252b33;background:#fff;font-family:system-ui,"Microsoft YaHei",sans-serif}*{box-sizing:border-box}body{max-width:900px;margin:0 auto;padding:42px 54px 80px;font-size:16px;line-height:1.78}h1{font-size:2.15em}h2{font-size:1.65em;border-bottom:1px solid #e5e8eb;padding-bottom:.25em}h3{font-size:1.3em}h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.35em 0 .65em;color:#1d232b}p{margin:.85em 0}a{color:#1769c2}img{display:block;max-width:100%;height:auto;margin:22px auto;border-radius:4px}blockquote{margin:1em 0;padding:.25em 1em;border-left:4px solid #cdd4dc;color:#65707c;background:#f8f9fa}pre{overflow:auto;padding:16px 18px;background:#f3f5f7;border-radius:7px}code{font-family:Consolas,ui-monospace,monospace;background:#f2f4f6;border-radius:4px;padding:.12em .32em}pre code{padding:0;background:none}table{border-collapse:collapse;max-width:100%}th,td{border:1px solid #d7dce1;padding:7px 12px}hr{border:0;border-top:1px solid #dfe3e7;margin:2em 0}
</style></head><body>${html}</body></html>`;

function applyPreview(html) {
  preview.onload = () => {
    preview.contentDocument?.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((heading, index) => {
      heading.id = `mdparcel-heading-${index}`;
    });
  };
  preview.srcdoc = previewDocument(html);
}

async function refreshPreview(immediateHtml = null) {
  if (immediateHtml !== null) {
    applyPreview(immediateHtml);
    return;
  }
  const version = ++state.renderVersion;
  try {
    const html = await invoke("render_markdown", {
      markdown: editor.value,
      sourcePath: state.path,
    });
    if (version === state.renderVersion) applyPreview(html);
  } catch (error) {
    showToast(`预览失败：${error}`, true);
  }
}

let renderTimer;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => refreshPreview(), 220);
}

function extractOutline() {
  const headings = [];
  editor.value.split("\n").forEach((line, lineIndex) => {
    const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) headings.push({ level: match[1].length, text: match[2], line: lineIndex });
  });
  const container = document.getElementById("outline");
  container.replaceChildren();
  document.getElementById("outline-empty").hidden = headings.length > 0;
  headings.forEach((heading, index) => {
    const button = document.createElement("button");
    button.textContent = heading.text;
    button.className = `outline-item level-${heading.level}`;
    button.title = heading.text;
    button.addEventListener("click", () => navigateHeading(heading.line, index));
    container.appendChild(button);
  });
}

function navigateHeading(lineIndex, headingIndex) {
  if (state.mode !== "preview") {
    const lines = editor.value.split("\n");
    const start = lines.slice(0, lineIndex).reduce((sum, line) => sum + line.length + 1, 0);
    editor.focus();
    editor.setSelectionRange(start, start + lines[lineIndex].length);
    editor.scrollTop = Math.max(0, lineIndex * 24 - editor.clientHeight / 3);
  }
  if (state.mode !== "source") {
    preview.contentDocument?.getElementById(`mdparcel-heading-${headingIndex}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function isModified() {
  return editor.value !== state.markdown || titleInput.value !== state.title;
}

function updateUi() {
  state.dirty = isModified();
  const visibleTitle = titleInput.value.trim() || "未命名文档";
  document.getElementById("window-document").textContent = `${state.dirty ? "● " : ""}${visibleTitle}`;
  document.getElementById("file-title").textContent = visibleTitle;
  document.getElementById("file-path").textContent = state.path || "尚未保存";
  document.getElementById("asset-summary").textContent = `${state.assetCount} 个包内资源`;
  document.getElementById("save-state").textContent = state.dirty ? "未保存" : "已保存";
  document.getElementById("line-count").textContent = `${editor.value.split("\n").length} 行`;
  document.getElementById("char-count").textContent = `${editor.value.length} 字符`;
  document.title = `${state.dirty ? "*" : ""}${visibleTitle} - MDParcel Editor`;
  extractOutline();
}

function loadDocument(data, path = null) {
  state.path = path;
  state.title = data.title;
  state.markdown = data.markdown;
  state.assetCount = data.assetCount || 0;
  titleInput.value = data.title;
  editor.value = data.markdown;
  updateUi();
  refreshPreview(data.html);
}

function confirmDiscard() {
  return !isModified() || window.confirm("当前文档尚未保存，是否放弃这些修改？");
}

async function newDocument() {
  if (!confirmDiscard()) return;
  loadDocument({ title: "未命名文档", markdown: "# 未命名文档\n\n", html: "<h1>未命名文档</h1>", assetCount: 0 });
  state.markdown = "";
  state.title = "";
  updateUi();
  editor.focus();
}

async function openDocument() {
  if (!confirmDiscard()) return;
  const path = await open({ multiple: false, filters: [{ name: "MDParcel 文档", extensions: ["mdparcel"] }] });
  if (!path) return;
  try {
    const data = await invoke("open_package", { path });
    loadDocument(data, path);
    showToast("文档已打开");
  } catch (error) {
    window.alert(`无法打开该文件：${error}`);
  }
}

async function saveDocument(saveAs = false) {
  let target = state.path;
  if (!target || saveAs) {
    target = await saveDialog({
      defaultPath: `${titleInput.value.trim() || "未命名文档"}.mdparcel`,
      filters: [{ name: "MDParcel 文档", extensions: ["mdparcel"] }],
    });
    if (!target) return false;
    if (!target.toLowerCase().endsWith(".mdparcel")) target += ".mdparcel";
  }
  try {
    await invoke("save_package", {
      sourcePath: state.path,
      targetPath: target,
      title: titleInput.value.trim() || "未命名文档",
      markdown: editor.value,
    });
    state.path = target;
    state.title = titleInput.value;
    state.markdown = editor.value;
    updateUi();
    await refreshPreview();
    showToast("文档已保存");
    return true;
  } catch (error) {
    window.alert(`保存失败：${error}`);
    return false;
  }
}

async function insertImage() {
  if (!state.path && !(await saveDocument(false))) return;
  const assetPath = await open({
    multiple: false,
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
  });
  if (!assetPath) return;
  try {
    const archivePath = await invoke("import_asset", { packagePath: state.path, assetPath });
    state.assetCount += 1;
    insertText(`![图片](${archivePath})`, "", "");
    await saveDocument(false);
    showToast("图片已导入文档包");
  } catch (error) {
    window.alert(`导入图片失败：${error}`);
  }
}

function insertText(before, after = before, placeholder = "文本") {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = editor.value.slice(start, end) || placeholder;
  editor.setRangeText(`${before}${selected}${after}`, start, end, "end");
  editor.focus();
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function prefixLines(prefixFactory) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const lineStart = editor.value.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = editor.value.indexOf("\n", end);
  const lineEnd = nextBreak < 0 ? editor.value.length : nextBreak;
  const changed = editor.value.slice(lineStart, lineEnd).split("\n").map((line, index) => `${prefixFactory(index)}${line}`).join("\n");
  editor.setRangeText(changed, lineStart, lineEnd, "select");
  editor.focus();
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function setHeading(level) {
  const start = editor.selectionStart;
  const lineStart = editor.value.lastIndexOf("\n", start - 1) + 1;
  const lineEndIndex = editor.value.indexOf("\n", start);
  const lineEnd = lineEndIndex < 0 ? editor.value.length : lineEndIndex;
  const line = editor.value.slice(lineStart, lineEnd).replace(/^\s{0,3}#{1,6}\s+/, "");
  const prefix = level ? `${"#".repeat(level)} ` : "";
  editor.setRangeText(`${prefix}${line}`, lineStart, lineEnd, "end");
  editor.focus();
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function setMode(mode) {
  state.mode = mode;
  editorShell.className = `editor-shell mode-${mode}`;
  document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  document.getElementById("mode-state").textContent = ({ source: "源码模式", preview: "预览模式", split: "分屏模式" })[mode];
}

async function clipboardAction(action) {
  editor.focus();
  if (action === "select-all") return editor.select();
  if (action === "copy" || action === "cut") {
    const text = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    if (text) await navigator.clipboard.writeText(text);
    if (action === "cut" && text) editor.setRangeText("", editor.selectionStart, editor.selectionEnd, "end");
  } else if (action === "paste") {
    insertText(await navigator.clipboard.readText(), "", "");
  } else {
    document.execCommand(action);
  }
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

const actions = {
  new: newDocument, open: openDocument, save: () => saveDocument(false), "save-as": () => saveDocument(true), "insert-image": insertImage,
  source: () => setMode("source"), preview: () => setMode("preview"), split: () => setMode("split"),
  "toggle-sidebar": () => sidebar.classList.toggle("hidden"),
  h1: () => setHeading(1), h2: () => setHeading(2), h3: () => setHeading(3),
  bold: () => insertText("**", "**", "粗体文本"), italic: () => insertText("*", "*", "斜体文本"), code: () => insertText("`", "`", "代码"),
  quote: () => prefixLines(() => "> "), "unordered-list": () => prefixLines(() => "- "), "ordered-list": () => prefixLines((index) => `${index + 1}. `),
  link: () => insertText("[", "](https://)", "链接文本"),
  undo: () => clipboardAction("undo"), redo: () => clipboardAction("redo"), cut: () => clipboardAction("cut"), copy: () => clipboardAction("copy"), paste: () => clipboardAction("paste"), "select-all": () => clipboardAction("select-all"),
  about: () => window.alert("MDParcel Editor 0.1.0\n使用 Rust 与 Tauri 构建的可移植 Markdown 文档包编辑器。"),
};

document.addEventListener("click", (event) => {
  const trigger = event.target.closest(".menu-trigger");
  document.querySelectorAll(".menu.open").forEach((menu) => {
    if (!trigger || menu !== trigger.parentElement) menu.classList.remove("open");
  });
  if (trigger) return trigger.parentElement.classList.toggle("open");
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action && actions[action]) {
    document.querySelectorAll(".menu.open").forEach((menu) => menu.classList.remove("open"));
    Promise.resolve(actions[action]()).catch((error) => showToast(String(error), true));
  }
});

document.querySelectorAll("[data-tab]").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll("[data-tab]").forEach((item) => item.classList.toggle("active", item === tab));
  document.getElementById("file-panel").hidden = tab.dataset.tab !== "file";
  document.getElementById("outline-panel").hidden = tab.dataset.tab !== "outline";
}));

document.getElementById("heading-level").addEventListener("change", (event) => {
  const levels = { paragraph: 0, h1: 1, h2: 2, h3: 3 };
  setHeading(levels[event.target.value]);
  event.target.value = "paragraph";
});

editor.addEventListener("input", () => { updateUi(); scheduleRender(); });
titleInput.addEventListener("input", updateUi);
editor.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    insertText("  ", "", "");
  }
});

window.addEventListener("keydown", (event) => {
  if (!event.ctrlKey) return;
  const key = event.key.toLowerCase();
  if (key === "s") { event.preventDefault(); saveDocument(event.shiftKey); }
  if (key === "o") { event.preventDefault(); openDocument(); }
  if (key === "n") { event.preventDefault(); newDocument(); }
  if (key === "b") { event.preventDefault(); actions.bold(); }
  if (key === "i") { event.preventDefault(); actions.italic(); }
  if (key === "\\") { event.preventDefault(); setMode("split"); }
});

window.addEventListener("beforeunload", (event) => {
  if (isModified()) { event.preventDefault(); event.returnValue = ""; }
});

let toastTimer;
function showToast(message, error = false) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

loadDocument({ title: state.title, markdown: state.markdown, html: "<h1>未命名文档</h1><p>开始编写你的 Markdown 文档。</p>", assetCount: 0 });
state.title = "";
state.markdown = "";
updateUi();
