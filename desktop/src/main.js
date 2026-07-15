import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  createDocument,
  displayTitle,
  findMatches,
  isDocumentDirty,
  markdownImage,
  replaceAllLiteral,
} from "./editor-core.js";

const editor = document.getElementById("markdown-editor");
const richEditor = document.getElementById("wysiwyg-editor");
const titleInput = document.getElementById("document-title");
const editorShell = document.getElementById("editor-shell");
const sidebar = document.getElementById("sidebar");
const tabs = document.getElementById("document-tabs");
const findPanel = document.getElementById("find-panel");
const findInput = document.getElementById("find-input");
const replaceInput = document.getElementById("replace-input");
const matchCase = document.getElementById("match-case");

const state = {
  documents: [],
  activeId: null,
  mode: "split",
  editSurface: "source",
  syncing: false,
  renderTimer: null,
  findIndex: -1,
};

const activeDocument = () => state.documents.find((item) => item.id === state.activeId);

function persistActiveFields() {
  const doc = activeDocument();
  if (!doc) return;
  doc.title = titleInput.value;
  doc.markdown = editor.value;
}

function sanitizeHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script,style,iframe,object,embed,form,input,button").forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((node) => {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on") || name === "style" || ((name === "href" || name === "src") && value.startsWith("javascript:"))) {
        node.removeAttribute(attribute.name);
      }
    }
  });
  return template.innerHTML;
}

function applyRichHtml(html) {
  state.syncing = true;
  richEditor.innerHTML = sanitizeHtml(html);
  richEditor.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((heading, index) => {
    heading.id = `mdparcel-heading-${index}`;
  });
  state.syncing = false;
}

function inlineText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\u00a0/g, " ");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName.toLowerCase();
  const content = [...node.childNodes].map(inlineText).join("");
  if (tag === "br") return "\n";
  if (tag === "strong" || tag === "b") return `**${content}**`;
  if (tag === "em" || tag === "i") return `*${content}*`;
  if (tag === "del" || tag === "s") return `~~${content}~~`;
  if (tag === "code") return `\`${content.replace(/`/g, "\\`")}\``;
  if (tag === "a") return `[${content}](${node.getAttribute("href") || ""})`;
  if (tag === "img") return markdownImage(node.dataset.mdSrc || node.getAttribute("src") || "", node.getAttribute("alt") || "图片");
  return content;
}

function listToMarkdown(list, depth = 0) {
  const ordered = list.tagName.toLowerCase() === "ol";
  return [...list.children].filter((item) => item.tagName?.toLowerCase() === "li").map((item, index) => {
    const nested = [...item.children].filter((child) => ["ul", "ol"].includes(child.tagName.toLowerCase()));
    const clone = item.cloneNode(true);
    clone.querySelectorAll(":scope > ul, :scope > ol").forEach((child) => child.remove());
    const line = `${"  ".repeat(depth)}${ordered ? `${index + 1}.` : "-"} ${inlineText(clone).trim()}`;
    return [line, ...nested.map((child) => listToMarkdown(child, depth + 1))].join("\n");
  }).join("\n");
}

function tableToMarkdown(table) {
  const rows = [...table.querySelectorAll("tr")].map((row) => [...row.children].map((cell) => inlineText(cell).trim().replace(/\|/g, "\\|")));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
  return [normalized[0], Array(width).fill("---"), ...normalized.slice(1)].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

function blockToMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.trim() ? node.nodeValue : "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${inlineText(node).trim()}`;
  if (tag === "p" || tag === "div") return inlineText(node).trimEnd();
  if (tag === "pre") return `\`\`\`\n${node.textContent.replace(/\n$/, "")}\n\`\`\``;
  if (tag === "blockquote") return [...node.childNodes].map(blockToMarkdown).join("\n\n").split("\n").map((line) => `> ${line}`).join("\n");
  if (tag === "ul" || tag === "ol") return listToMarkdown(node);
  if (tag === "hr") return "---";
  if (tag === "table") return tableToMarkdown(node);
  if (tag === "img") return inlineText(node);
  return [...node.childNodes].map(blockToMarkdown).join("\n\n");
}

function richHtmlToMarkdown() {
  return [...richEditor.childNodes]
    .map(blockToMarkdown)
    .join("\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}

async function refreshRichHtml(immediateHtml = null) {
  const doc = activeDocument();
  if (!doc) return;
  if (immediateHtml !== null) {
    doc.html = immediateHtml;
    applyRichHtml(immediateHtml);
    return;
  }
  const version = ++doc.renderVersion;
  try {
    const html = await invoke("render_markdown", { markdown: doc.markdown, sourcePath: doc.path });
    if (doc === activeDocument() && version === doc.renderVersion && state.editSurface !== "rich") applyRichHtml(html);
    if (version === doc.renderVersion) doc.html = html;
  } catch (error) {
    showToast(`渲染失败：${error}`, true);
  }
}

function scheduleRender() {
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(() => refreshRichHtml(), 180);
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
    button.addEventListener("click", () => navigateHeading(heading.line, index));
    container.appendChild(button);
  });
}

function navigateHeading(lineIndex, headingIndex) {
  if (state.mode !== "wysiwyg") {
    const lines = editor.value.split("\n");
    const start = lines.slice(0, lineIndex).reduce((sum, line) => sum + line.length + 1, 0);
    editor.focus();
    editor.setSelectionRange(start, start + lines[lineIndex].length);
    editor.scrollTop = Math.max(0, lineIndex * 24 - editor.clientHeight / 3);
  }
  if (state.mode !== "source") richEditor.querySelector(`#mdparcel-heading-${headingIndex}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderTabs() {
  tabs.replaceChildren();
  for (const doc of state.documents) {
    const tab = document.createElement("button");
    tab.className = `document-tab${doc.id === state.activeId ? " active" : ""}`;
    tab.dataset.documentId = String(doc.id);
    tab.setAttribute("role", "tab");
    tab.innerHTML = `<span class="document-tab-dirty">${isDocumentDirty(doc) ? "●" : ""}</span><span class="document-tab-title"></span><span class="document-tab-close" title="关闭">×</span>`;
    tab.querySelector(".document-tab-title").textContent = displayTitle(doc);
    tabs.appendChild(tab);
  }
  const add = document.createElement("button");
  add.className = "document-tab new-tab";
  add.dataset.action = "new";
  add.title = "新建文档";
  add.textContent = "+";
  tabs.appendChild(add);
}

function updateUi() {
  persistActiveFields();
  const doc = activeDocument();
  if (!doc) return;
  const dirty = isDocumentDirty(doc);
  const visibleTitle = displayTitle(doc);
  document.getElementById("window-document").textContent = `${dirty ? "● " : ""}${visibleTitle}`;
  document.getElementById("file-title").textContent = visibleTitle;
  document.getElementById("file-path").textContent = doc.path || "尚未保存";
  document.getElementById("asset-summary").textContent = `${doc.assetCount} 个包内资源`;
  document.getElementById("save-state").textContent = dirty ? "未保存" : "已保存";
  document.getElementById("line-count").textContent = `${doc.markdown.split("\n").length} 行`;
  document.getElementById("char-count").textContent = `${doc.markdown.length} 字符`;
  document.title = `${dirty ? "*" : ""}${visibleTitle} - MDParcel Editor`;
  extractOutline();
  renderTabs();
  updateFindCount();
}

async function activateDocument(id) {
  persistActiveFields();
  const doc = state.documents.find((item) => item.id === id);
  if (!doc) return;
  state.activeId = id;
  titleInput.value = doc.title;
  editor.value = doc.markdown;
  state.findIndex = -1;
  updateUi();
  if (doc.html) applyRichHtml(doc.html);
  await refreshRichHtml();
}

async function newDocument() {
  const doc = createDocument();
  state.documents.push(doc);
  await activateDocument(doc.id);
  editor.focus();
}

async function closeDocument(id) {
  const index = state.documents.findIndex((item) => item.id === id);
  if (index < 0) return;
  const doc = state.documents[index];
  if (isDocumentDirty(doc) && !window.confirm(`“${displayTitle(doc)}”尚未保存，确定关闭吗？`)) return;
  state.documents.splice(index, 1);
  if (!state.documents.length) return newDocument();
  if (state.activeId === id) await activateDocument(state.documents[Math.min(index, state.documents.length - 1)].id);
  else renderTabs();
}

async function openDocument() {
  const selected = await open({ multiple: true, filters: [{ name: "MDParcel 文档", extensions: ["mdparcel"] }] });
  const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
  for (const path of paths) {
    const existing = state.documents.find((item) => item.path?.toLocaleLowerCase() === path.toLocaleLowerCase());
    if (existing) {
      await activateDocument(existing.id);
      continue;
    }
    try {
      const data = await invoke("open_package", { path });
      const doc = createDocument(data, path);
      state.documents.push(doc);
      await activateDocument(doc.id);
    } catch (error) {
      window.alert(`无法打开 ${path}：${error}`);
    }
  }
  if (paths.length) showToast(`已打开 ${paths.length} 个文档`);
}

async function saveDocument(saveAs = false) {
  persistActiveFields();
  const doc = activeDocument();
  if (!doc) return false;
  let target = doc.path;
  if (!target || saveAs) {
    target = await saveDialog({
      defaultPath: `${displayTitle(doc)}.mdparcel`,
      filters: [{ name: "MDParcel 文档", extensions: ["mdparcel"] }],
    });
    if (!target) return false;
    if (!target.toLocaleLowerCase().endsWith(".mdparcel")) target += ".mdparcel";
  }
  try {
    await invoke("save_package", {
      sourcePath: doc.path,
      targetPath: target,
      title: displayTitle(doc),
      markdown: doc.markdown,
    });
    doc.path = target;
    doc.savedTitle = doc.title;
    doc.savedMarkdown = doc.markdown;
    await refreshRichHtml();
    updateUi();
    showToast("文档已保存");
    return true;
  } catch (error) {
    window.alert(`保存失败：${error}`);
    return false;
  }
}

function insertMarkdown(text) {
  if (state.editSurface === "source" && document.activeElement === editor) {
    const start = editor.selectionStart;
    editor.setRangeText(text, start, editor.selectionEnd, "end");
  } else {
    const separator = editor.value.endsWith("\n") ? "\n" : "\n\n";
    editor.value += `${separator}${text}\n`;
  }
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function imagePathsOnly(paths) {
  const supported = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
  return paths.filter((path) => supported.has(path.split(".").pop()?.toLocaleLowerCase()));
}

async function importImages(paths) {
  paths = imagePathsOnly(paths);
  if (!paths.length) return showToast("请拖入受支持的图片文件", true);
  if (!activeDocument().path && !(await saveDocument(false))) return;
  const imported = [];
  try {
    for (const assetPath of paths) {
      const archivePath = await invoke("import_asset", { packagePath: activeDocument().path, assetPath });
      const name = assetPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
      imported.push(markdownImage(archivePath, name));
      activeDocument().assetCount += 1;
    }
    insertMarkdown(imported.join("\n\n"));
    await saveDocument(false);
    showToast(`已将 ${imported.length} 张图片写入文档包`);
  } catch (error) {
    window.alert(`导入图片失败：${error}`);
  }
}

async function insertImage() {
  const selected = await open({ multiple: true, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"] }] });
  await importImages(Array.isArray(selected) ? selected : selected ? [selected] : []);
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

function useRichEditor() {
  return state.mode === "wysiwyg" || (state.mode === "split" && state.editSurface === "rich");
}

function richCommand(command, value = null) {
  richEditor.focus();
  document.execCommand(command, false, value);
  richEditor.dispatchEvent(new Event("input", { bubbles: true }));
}

function setHeading(level) {
  if (useRichEditor()) return richCommand("formatBlock", level ? `h${level}` : "p");
  const start = editor.selectionStart;
  const lineStart = editor.value.lastIndexOf("\n", start - 1) + 1;
  const lineEndIndex = editor.value.indexOf("\n", start);
  const lineEnd = lineEndIndex < 0 ? editor.value.length : lineEndIndex;
  const line = editor.value.slice(lineStart, lineEnd).replace(/^\s{0,3}#{1,6}\s+/, "");
  editor.setRangeText(`${level ? `${"#".repeat(level)} ` : ""}${line}`, lineStart, lineEnd, "end");
  editor.focus();
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function setMode(mode) {
  state.mode = mode;
  editorShell.className = `editor-shell mode-${mode}`;
  document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  document.getElementById("mode-state").textContent = ({ source: "Markdown 模式", wysiwyg: "所见即所得", split: "双向分屏" })[mode];
  if (mode !== "source") refreshRichHtml();
}

async function clipboardAction(action) {
  const target = useRichEditor() ? richEditor : editor;
  target.focus();
  if (action === "select-all") return document.execCommand("selectAll");
  document.execCommand(action);
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

function showFind(replace = false) {
  findPanel.hidden = false;
  replaceInput.style.display = replace ? "" : "none";
  findPanel.querySelectorAll('[data-action="replace-one"],[data-action="replace-all"]').forEach((button) => button.style.display = replace ? "" : "none");
  const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  if (selected && !selected.includes("\n")) findInput.value = selected;
  state.findIndex = -1;
  updateFindCount();
  findInput.focus();
  findInput.select();
}

function currentMatches() {
  return findMatches(editor.value, findInput.value, matchCase.checked);
}

function updateFindCount() {
  const matches = currentMatches();
  if (state.findIndex >= matches.length) state.findIndex = matches.length - 1;
  document.getElementById("find-count").textContent = matches.length ? `${Math.max(0, state.findIndex) + 1}/${matches.length}` : "0/0";
}

function findStep(direction = 1) {
  const matches = currentMatches();
  if (!matches.length) return updateFindCount();
  state.findIndex = (state.findIndex + direction + matches.length) % matches.length;
  const match = matches[state.findIndex];
  if (state.mode === "wysiwyg") setMode("source");
  editor.focus();
  editor.setSelectionRange(match.start, match.end);
  const line = editor.value.slice(0, match.start).split("\n").length - 1;
  editor.scrollTop = Math.max(0, line * 26 - editor.clientHeight / 2);
  updateFindCount();
}

function replaceOne() {
  const matches = currentMatches();
  if (!matches.length) return;
  if (state.findIndex < 0) state.findIndex = 0;
  const match = matches[state.findIndex];
  editor.setRangeText(replaceInput.value, match.start, match.end, "end");
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  findStep(0);
}

function replaceAll() {
  const result = replaceAllLiteral(editor.value, findInput.value, replaceInput.value, matchCase.checked);
  if (!result.count) return showToast("没有匹配项");
  editor.value = result.text;
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  state.findIndex = -1;
  updateFindCount();
  showToast(`已替换 ${result.count} 处`);
}

const actions = {
  new: newDocument,
  open: openDocument,
  save: () => saveDocument(false),
  "save-as": () => saveDocument(true),
  "insert-image": insertImage,
  source: () => setMode("source"),
  wysiwyg: () => setMode("wysiwyg"),
  split: () => setMode("split"),
  "toggle-sidebar": () => sidebar.classList.toggle("hidden"),
  h1: () => setHeading(1), h2: () => setHeading(2), h3: () => setHeading(3),
  bold: () => useRichEditor() ? richCommand("bold") : insertText("**", "**", "粗体文本"),
  italic: () => useRichEditor() ? richCommand("italic") : insertText("*", "*", "斜体文本"),
  code: () => useRichEditor() ? richCommand("formatBlock", "pre") : insertText("`", "`", "代码"),
  quote: () => useRichEditor() ? richCommand("formatBlock", "blockquote") : prefixLines(() => "> "),
  "unordered-list": () => useRichEditor() ? richCommand("insertUnorderedList") : prefixLines(() => "- "),
  "ordered-list": () => useRichEditor() ? richCommand("insertOrderedList") : prefixLines((index) => `${index + 1}. `),
  link: () => useRichEditor() ? richCommand("createLink", window.prompt("链接地址", "https://") || "") : insertText("[", "](https://)", "链接文本"),
  undo: () => clipboardAction("undo"), redo: () => clipboardAction("redo"), cut: () => clipboardAction("cut"), copy: () => clipboardAction("copy"), paste: () => clipboardAction("paste"), "select-all": () => clipboardAction("select-all"),
  find: () => showFind(false), replace: () => showFind(true), "find-next": () => findStep(1), "find-previous": () => findStep(-1), "replace-one": replaceOne, "replace-all": replaceAll, "close-find": () => findPanel.hidden = true,
  about: () => window.alert("MDParcel Editor 0.2.0\n多文档、图片资源与双向 Markdown 编辑器。"),
};

document.addEventListener("click", (event) => {
  const close = event.target.closest(".document-tab-close");
  if (close) {
    event.stopPropagation();
    return closeDocument(Number(close.closest(".document-tab").dataset.documentId));
  }
  const tab = event.target.closest(".document-tab[data-document-id]");
  if (tab) return activateDocument(Number(tab.dataset.documentId));
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
  setHeading({ paragraph: 0, h1: 1, h2: 2, h3: 3 }[event.target.value]);
  event.target.value = "paragraph";
});

editor.addEventListener("focus", () => state.editSurface = "source");
richEditor.addEventListener("focus", () => state.editSurface = "rich");
editor.addEventListener("input", () => {
  if (state.syncing) return;
  activeDocument().markdown = editor.value;
  activeDocument().html = "";
  updateUi();
  scheduleRender();
});
richEditor.addEventListener("input", () => {
  if (state.syncing) return;
  state.syncing = true;
  const markdown = richHtmlToMarkdown();
  activeDocument().markdown = markdown;
  activeDocument().html = richEditor.innerHTML;
  editor.value = markdown;
  state.syncing = false;
  updateUi();
});
titleInput.addEventListener("input", () => {
  activeDocument().title = titleInput.value;
  updateUi();
});
editor.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    insertText("  ", "", "");
  }
});
findInput.addEventListener("input", () => { state.findIndex = -1; updateFindCount(); });
findInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); findStep(event.shiftKey ? -1 : 1); }
  if (event.key === "Escape") findPanel.hidden = true;
});
matchCase.addEventListener("change", () => { state.findIndex = -1; updateFindCount(); });

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !findPanel.hidden) findPanel.hidden = true;
  if (!event.ctrlKey) return;
  const key = event.key.toLowerCase();
  if (key === "s") { event.preventDefault(); saveDocument(event.shiftKey); }
  if (key === "o") { event.preventDefault(); openDocument(); }
  if (key === "n") { event.preventDefault(); newDocument(); }
  if (key === "w") { event.preventDefault(); closeDocument(state.activeId); }
  if (key === "f") { event.preventDefault(); showFind(false); }
  if (key === "h") { event.preventDefault(); showFind(true); }
  if (key === "b") { event.preventDefault(); actions.bold(); }
  if (key === "i") { event.preventDefault(); actions.italic(); }
  if (key === "\\") { event.preventDefault(); setMode("split"); }
});

window.addEventListener("beforeunload", (event) => {
  if (state.documents.some(isDocumentDirty)) { event.preventDefault(); event.returnValue = ""; }
});

document.addEventListener("dragover", (event) => {
  if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
    event.preventDefault();
    document.body.classList.add("dragging-image");
  }
});
document.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) document.body.classList.remove("dragging-image");
});
document.addEventListener("drop", (event) => {
  event.preventDefault();
  document.body.classList.remove("dragging-image");
  const paths = [...event.dataTransfer.files].map((file) => file.path).filter(Boolean);
  if (paths.length) importImages(paths);
});

try {
  getCurrentWebviewWindow().onDragDropEvent((event) => {
    const payload = event.payload;
    document.body.classList.toggle("dragging-image", payload.type === "enter" || payload.type === "over");
    if (payload.type === "drop") importImages(payload.paths || []);
  });
} catch (error) {
  console.warn("Native drag and drop is unavailable", error);
}

let toastTimer;
function showToast(message, error = false) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

newDocument();
