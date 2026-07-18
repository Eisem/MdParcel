import Vditor from "vditor";
import "vditor/dist/index.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { createDocument, displayTitle, findMatches, isDocumentDirty, markdownImage, replaceAllLiteral } from "./editor-core.js";

const editorHost = document.getElementById("hybrid-editor");
const titleInput = document.getElementById("document-title");
const workspace = document.getElementById("workspace");
const sidebar = document.getElementById("sidebar");
const sidebarResizer = document.getElementById("sidebar-resizer");
const sidebarToggle = document.getElementById("sidebar-toggle");
const tabs = document.getElementById("document-tabs");
const findPanel = document.getElementById("find-panel");
const findInput = document.getElementById("find-input");
const replaceInput = document.getElementById("replace-input");
const matchCase = document.getElementById("match-case");
const vditorCdn = new URL("./vditor", document.baseURI).href.replace(/\/$/, "");
const state = { documents: [], activeId: null, findIndex: -1 };
const activeDocument = () => state.documents.find((item) => item.id === state.activeId);
const sidebarLimits = { min: 180, max: 520 };
let sidebarWidth = Number.parseInt(localStorage.getItem("mdparcel.sidebar-width"), 10) || 278;
let resizingSidebar = false;

function maxSidebarWidth() {
  return Math.max(sidebarLimits.min, Math.min(sidebarLimits.max, workspace.clientWidth - 360));
}

function setSidebarWidth(width, persist = true) {
  sidebarWidth = Math.round(Math.max(sidebarLimits.min, Math.min(maxSidebarWidth(), width)));
  document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  sidebarResizer.setAttribute("aria-valuemin", String(sidebarLimits.min));
  sidebarResizer.setAttribute("aria-valuemax", String(maxSidebarWidth()));
  sidebarResizer.setAttribute("aria-valuenow", String(sidebarWidth));
  if (persist) localStorage.setItem("mdparcel.sidebar-width", String(sidebarWidth));
}

function setSidebarCollapsed(collapsed, persist = true) {
  sidebar.classList.toggle("hidden", collapsed);
  workspace.classList.toggle("sidebar-collapsed", collapsed);
  sidebarResizer.hidden = collapsed;
  sidebarToggle.classList.toggle("collapsed", collapsed);
  sidebarToggle.title = collapsed ? "展开侧边栏" : "收起侧边栏";
  sidebarToggle.setAttribute("aria-label", sidebarToggle.title);
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  if (persist) localStorage.setItem("mdparcel.sidebar-collapsed", String(collapsed));
}

function toggleSidebar() {
  setSidebarCollapsed(!sidebar.classList.contains("hidden"));
}

function extractImageSources(html) {
  const template = document.createElement("template");
  template.innerHTML = html || "";
  return new Map([...template.content.querySelectorAll("img[data-md-src]")].map((image) => [image.dataset.mdSrc, image.src]));
}

function markdownFor(doc) {
  if (doc.editor) doc.markdown = doc.editor.getValue();
  return doc.markdown;
}

function packageImageKey(doc, image) {
  const raw = image.dataset.mdparcelSource || image.getAttribute("data-src") || image.getAttribute("src") || "";
  let source = raw.replace(/\\/g, "/");
  try { source = decodeURIComponent(source); } catch (_) { /* malformed URL: compare as-is */ }
  return [...doc.imageSources.keys()].find((key) => source === key || source.endsWith(`/${key}`));
}

function replacePackageImages(doc) {
  if (!doc.mount || !doc.imageSources?.size) return;
  doc.mount.querySelectorAll("img").forEach((image) => {
    const key = packageImageKey(doc, image);
    if (!key) return;
    image.dataset.mdparcelSource = key;
    const dataUrl = doc.imageSources.get(key);
    if (image.getAttribute("src") !== dataUrl) image.setAttribute("src", dataUrl);
  });
}

function observePackageImages(doc) {
  doc.imageObserver = new MutationObserver(() => replacePackageImages(doc));
  doc.imageObserver.observe(doc.mount, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  replacePackageImages(doc);
}

async function refreshDocumentImages(doc = activeDocument()) {
  if (!doc?.path) return;
  try {
    const html = await invoke("render_markdown", { markdown: markdownFor(doc), sourcePath: doc.path });
    doc.imageSources = extractImageSources(html);
    replacePackageImages(doc);
  } catch (error) {
    showToast(`图片预览刷新失败：${error}`, true);
  }
}

function renderTabs() {
  tabs.replaceChildren();
  for (const doc of state.documents) {
    const tab = document.createElement("button");
    tab.className = `document-tab${doc.id === state.activeId ? " active" : ""}`;
    tab.dataset.documentId = String(doc.id);
    tab.setAttribute("role", "tab");
    tab.innerHTML = '<span class="document-tab-dirty"></span><span class="document-tab-title"></span><span class="document-tab-close" title="关闭">×</span>';
    tab.querySelector(".document-tab-dirty").textContent = isDocumentDirty(doc) ? "●" : "";
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

function outlineHeadings(doc) {
  const headings = [];
  markdownFor(doc).split("\n").forEach((line) => {
    const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) headings.push({ level: match[1].length, text: match[2] });
  });
  return headings;
}

function renderOutline() {
  const doc = activeDocument();
  const headings = outlineHeadings(doc);
  const container = document.getElementById("outline");
  container.replaceChildren();
  document.getElementById("outline-empty").hidden = headings.length > 0;
  headings.forEach((heading, index) => {
    const button = document.createElement("button");
    button.textContent = heading.text;
    button.className = `outline-item level-${heading.level}`;
    button.addEventListener("click", () => {
      const rendered = doc.mount.querySelectorAll("h1, h2, h3, h4, h5, h6")[index];
      rendered?.scrollIntoView({ behavior: "smooth", block: "center" });
      rendered?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      doc.editor.focus();
    });
    container.appendChild(button);
  });
}

function updateUi() {
  const doc = activeDocument();
  if (!doc) return;
  markdownFor(doc);
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
  renderOutline();
  renderTabs();
  updateFindCount();
}

async function createVditor(doc) {
  doc.mount = document.createElement("div");
  doc.mount.className = "vditor-document";
  editorHost.appendChild(doc.mount);
  await new Promise((resolve) => {
    doc.editor = new Vditor(doc.mount, {
      cdn: vditorCdn,
      lang: "zh_CN",
      mode: "ir",
      height: "100%",
      minHeight: 320,
      value: doc.markdown,
      cache: { enable: false },
      counter: { enable: false },
      outline: { enable: false },
      toolbarConfig: { pin: true },
      toolbar: [
        "head", "bold", "italic", "strike", "|", "line", "quote", "list", "ordered-list", "check", "|",
        "code", "inline-code", "link", "upload", "table", "|", "undo", "redo", "fullscreen", "outline",
      ],
      upload: {
        accept: "image/*",
        multiple: true,
        max: 25 * 1024 * 1024,
        handler: async (files) => {
          try {
            await importBrowserImages(doc, [...files]);
            return null;
          } catch (error) {
            showToast(`图片导入失败：${error}`, true);
            return String(error);
          }
        },
      },
      input: (value) => {
        doc.markdown = value;
        if (doc === activeDocument()) updateUi();
      },
      blur: (value) => { doc.markdown = value; },
      after: resolve,
    });
  });
  doc.mount.addEventListener("input", () => {
    requestAnimationFrame(() => {
      doc.markdown = doc.editor.getValue();
      if (doc === activeDocument()) updateUi();
    });
  });
  observePackageImages(doc);
}

async function activateDocument(id) {
  const doc = state.documents.find((item) => item.id === id);
  if (!doc) return;
  state.activeId = id;
  state.findIndex = -1;
  state.documents.forEach((item) => item.mount?.classList.toggle("hidden", item !== doc));
  titleInput.value = doc.title;
  updateUi();
  replacePackageImages(doc);
  doc.editor.focus();
}

async function newDocument() {
  const doc = createDocument();
  doc.imageSources = new Map();
  state.documents.push(doc);
  await createVditor(doc);
  await activateDocument(doc.id);
}

async function closeDocument(id) {
  const index = state.documents.findIndex((item) => item.id === id);
  if (index < 0) return;
  const doc = state.documents[index];
  markdownFor(doc);
  if (isDocumentDirty(doc) && !window.confirm(`“${displayTitle(doc)}”尚未保存，确定关闭吗？`)) return;
  doc.imageObserver?.disconnect();
  doc.editor?.destroy();
  doc.mount?.remove();
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
    if (existing) { await activateDocument(existing.id); continue; }
    try {
      const data = await invoke("open_package", { path });
      const doc = createDocument(data, path);
      doc.imageSources = extractImageSources(data.html);
      state.documents.push(doc);
      await createVditor(doc);
      await activateDocument(doc.id);
    } catch (error) {
      window.alert(`无法打开 ${path}：${error}`);
    }
  }
  if (paths.length) showToast(`已打开 ${paths.length} 个文档`);
}

async function saveDocument(saveAs = false, doc = activeDocument()) {
  if (!doc) return false;
  markdownFor(doc);
  let target = doc.path;
  if (!target || saveAs) {
    target = await saveDialog({ defaultPath: `${displayTitle(doc)}.mdparcel`, filters: [{ name: "MDParcel 文档", extensions: ["mdparcel"] }] });
    if (!target) return false;
    if (!target.toLocaleLowerCase().endsWith(".mdparcel")) target += ".mdparcel";
  }
  try {
    await invoke("save_package", { sourcePath: doc.path, targetPath: target, title: displayTitle(doc), markdown: doc.markdown });
    doc.path = target;
    doc.savedTitle = doc.title;
    doc.savedMarkdown = doc.markdown;
    if (doc === activeDocument()) updateUi();
    await refreshDocumentImages(doc);
    showToast("文档已保存");
    return true;
  } catch (error) {
    window.alert(`保存失败：${error}`);
    return false;
  }
}

async function exportZip() {
  const doc = activeDocument();
  if (!doc || !(await saveDocument(false, doc))) return;
  let target = await saveDialog({
    defaultPath: `${displayTitle(doc)}.zip`,
    filters: [{ name: "ZIP 文件", extensions: ["zip"] }],
  });
  if (!target) return;
  if (!target.toLocaleLowerCase().endsWith(".zip")) target += ".zip";
  try {
    await invoke("export_package", { packagePath: doc.path, targetPath: target });
    showToast("已导出 ZIP：document.md 和 src/");
  } catch (error) {
    window.alert(`导出 ZIP 失败：${error}`);
  }
}

function imagePathsOnly(paths) {
  const supported = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
  return paths.filter((path) => supported.has(path.split(".").pop()?.toLocaleLowerCase()));
}

async function importImages(paths, doc = activeDocument()) {
  paths = imagePathsOnly(paths);
  if (!paths.length) return showToast("请拖入受支持的图片文件", true);
  if (!doc.path && !(await saveDocument(false, doc))) return;
  const imported = [];
  try {
    for (const assetPath of paths) {
      const archivePath = await invoke("import_asset", { packagePath: doc.path, assetPath });
      const filename = assetPath.split(/[\\/]/).pop();
      imported.push(markdownImage(archivePath, filename.replace(/\.[^.]+$/, "")));
      doc.assetCount += 1;
    }
    doc.editor.insertMD(imported.join("\n\n"));
    await saveDocument(false, doc);
    showToast(`已将 ${imported.length} 张图片写入文档包`);
  } catch (error) {
    window.alert(`导入图片失败：${error}`);
  }
}

async function importBrowserImages(doc, files) {
  files = files.filter((file) => file.type.startsWith("image/"));
  if (!files.length) throw new Error("剪贴板或拖放内容中没有图片");
  if (!doc.path && !(await saveDocument(false, doc))) return;
  const imported = [];
  for (const file of files) {
    if (file.size > 25 * 1024 * 1024) throw new Error("单张图片不能超过 25 MiB");
    const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/bmp": "bmp", "image/avif": "avif" })[file.type] || "png";
    const filename = file.name && !/^image\.(png|jpg|jpeg)$/i.test(file.name) ? file.name : `pasted-${Date.now()}.${extension}`;
    const archivePath = await invoke("import_asset_bytes", {
      packagePath: doc.path,
      filename,
      mediaType: file.type || `image/${extension}`,
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
    });
    imported.push(markdownImage(archivePath, file.name ? file.name.replace(/\.[^.]+$/, "") : "粘贴图片"));
    doc.assetCount += 1;
  }
  doc.editor.insertMD(imported.join("\n\n"));
  await saveDocument(false, doc);
  showToast(`已将 ${imported.length} 张图片写入文档包`);
}

async function insertImage() {
  const selected = await open({ multiple: true, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"] }] });
  await importImages(Array.isArray(selected) ? selected : selected ? [selected] : []);
}

function focusEditor() { activeDocument()?.editor?.focus(); }

function triggerEditorCommand(command, heading = null) {
  const doc = activeDocument();
  if (!doc?.editor) return;
  doc.editor.focus();
  const elements = doc.editor.vditor?.toolbar?.elements;
  const item = elements?.[heading ? "headings" : command];
  const control = heading ? item?.querySelector(`[data-tag="h${heading}"]`) : item?.children?.[0];
  if (!control) return showToast("当前编辑位置不能使用此格式", true);
  control.click();
  requestAnimationFrame(() => {
    doc.markdown = doc.editor.getValue();
    updateUi();
  });
}

function clipboardAction(action) {
  focusEditor();
  document.execCommand(action === "select-all" ? "selectAll" : action);
}

function showFind(replace = false) {
  findPanel.hidden = false;
  replaceInput.style.display = replace ? "" : "none";
  findPanel.querySelectorAll('[data-action="replace-one"],[data-action="replace-all"]').forEach((button) => { button.style.display = replace ? "" : "none"; });
  const selected = activeDocument()?.editor.getSelection() || "";
  if (selected && !selected.includes("\n")) findInput.value = selected;
  state.findIndex = -1;
  updateFindCount();
  findInput.focus();
  findInput.select();
}

function currentMatches() {
  const doc = activeDocument();
  return doc ? findMatches(markdownFor(doc), findInput.value, matchCase.checked) : [];
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
  activeDocument().editor.focus();
  window.find(findInput.value, matchCase.checked, direction < 0, true, false, false, false);
  updateFindCount();
}

function replaceOne() {
  const doc = activeDocument();
  const matches = currentMatches();
  if (!doc || !matches.length) return;
  if (state.findIndex < 0) state.findIndex = 0;
  const match = matches[state.findIndex];
  const markdown = markdownFor(doc);
  doc.editor.setValue(markdown.slice(0, match.start) + replaceInput.value + markdown.slice(match.end));
  doc.markdown = doc.editor.getValue();
  state.findIndex -= 1;
  updateUi();
  findStep(1);
}

function replaceAll() {
  const doc = activeDocument();
  if (!doc) return;
  const result = replaceAllLiteral(markdownFor(doc), findInput.value, replaceInput.value, matchCase.checked);
  if (!result.count) return showToast("没有匹配项");
  doc.editor.setValue(result.text);
  doc.markdown = result.text;
  state.findIndex = -1;
  updateUi();
  showToast(`已替换 ${result.count} 处`);
}

const actions = {
  new: newDocument,
  open: openDocument,
  save: () => saveDocument(false),
  "save-as": () => saveDocument(true),
  "export-zip": exportZip,
  "insert-image": insertImage,
  "toggle-sidebar": toggleSidebar,
  undo: () => triggerEditorCommand("undo"),
  redo: () => triggerEditorCommand("redo"),
  cut: () => clipboardAction("cut"),
  copy: () => clipboardAction("copy"),
  paste: () => clipboardAction("paste"),
  "select-all": () => clipboardAction("select-all"),
  "format-h1": () => triggerEditorCommand(null, 1),
  "format-h2": () => triggerEditorCommand(null, 2),
  "format-h3": () => triggerEditorCommand(null, 3),
  "format-bold": () => triggerEditorCommand("bold"),
  "format-italic": () => triggerEditorCommand("italic"),
  "format-strike": () => triggerEditorCommand("strike"),
  "format-inline-code": () => triggerEditorCommand("inline-code"),
  "format-quote": () => triggerEditorCommand("quote"),
  "format-list": () => triggerEditorCommand("list"),
  "format-ordered-list": () => triggerEditorCommand("ordered-list"),
  "format-check": () => triggerEditorCommand("check"),
  "format-code": () => triggerEditorCommand("code"),
  "format-link": () => triggerEditorCommand("link"),
  "format-table": () => triggerEditorCommand("table"),
  find: () => showFind(false),
  replace: () => showFind(true),
  "find-next": () => findStep(1),
  "find-previous": () => findStep(-1),
  "replace-one": replaceOne,
  "replace-all": replaceAll,
  "close-find": () => { findPanel.hidden = true; focusEditor(); },
  about: () => window.alert("MDParcel Editor 0.3.0 测试版\nVditor IR 即时渲染编辑器与包内图片支持。"),
};

document.addEventListener("click", (event) => {
  const close = event.target.closest(".document-tab-close");
  if (close) { event.stopPropagation(); return closeDocument(Number(close.closest(".document-tab").dataset.documentId)); }
  const tab = event.target.closest(".document-tab[data-document-id]");
  if (tab) return activateDocument(Number(tab.dataset.documentId));
  const trigger = event.target.closest(".menu-trigger");
  document.querySelectorAll(".menu.open").forEach((menu) => { if (!trigger || menu !== trigger.parentElement) menu.classList.remove("open"); });
  if (trigger) return trigger.parentElement.classList.toggle("open");
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action && actions[action]) {
    document.querySelectorAll(".menu.open").forEach((menu) => menu.classList.remove("open"));
    Promise.resolve(actions[action]()).catch((error) => showToast(String(error), true));
  }
});

document.addEventListener("mousedown", (event) => {
  if (event.target.closest(".menu-trigger") || event.target.closest('[data-action^="format-"]')) event.preventDefault();
});

function resizeSidebar(event) {
  setSidebarWidth(event.clientX - workspace.getBoundingClientRect().left);
}

function finishSidebarResize(event) {
  if (!resizingSidebar) return;
  resizingSidebar = false;
  workspace.classList.remove("resizing");
  if (event && sidebarResizer.hasPointerCapture(event.pointerId)) sidebarResizer.releasePointerCapture(event.pointerId);
}

sidebarToggle.addEventListener("click", toggleSidebar);
sidebarResizer.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  resizingSidebar = true;
  workspace.classList.add("resizing");
  sidebarResizer.setPointerCapture(event.pointerId);
  resizeSidebar(event);
  event.preventDefault();
});
sidebarResizer.addEventListener("pointermove", (event) => {
  if (resizingSidebar) resizeSidebar(event);
});
sidebarResizer.addEventListener("pointerup", finishSidebarResize);
sidebarResizer.addEventListener("pointercancel", finishSidebarResize);
sidebarResizer.addEventListener("keydown", (event) => {
  const step = event.shiftKey ? 50 : 20;
  if (event.key === "ArrowLeft") setSidebarWidth(sidebarWidth - step);
  else if (event.key === "ArrowRight") setSidebarWidth(sidebarWidth + step);
  else if (event.key === "Home") setSidebarWidth(sidebarLimits.min);
  else if (event.key === "End") setSidebarWidth(maxSidebarWidth());
  else return;
  event.preventDefault();
});
window.addEventListener("resize", () => setSidebarWidth(sidebarWidth, false));

document.querySelectorAll("[data-tab]").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll("[data-tab]").forEach((item) => item.classList.toggle("active", item === tab));
  document.getElementById("file-panel").hidden = tab.dataset.tab !== "file";
  document.getElementById("outline-panel").hidden = tab.dataset.tab !== "outline";
}));
titleInput.addEventListener("input", () => { const doc = activeDocument(); if (doc) { doc.title = titleInput.value; updateUi(); } });
findInput.addEventListener("input", () => { state.findIndex = -1; updateFindCount(); });
findInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); findStep(event.shiftKey ? -1 : 1); } if (event.key === "Escape") findPanel.hidden = true; });
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
});

window.addEventListener("beforeunload", (event) => {
  state.documents.forEach(markdownFor);
  if (state.documents.some(isDocumentDirty)) { event.preventDefault(); event.returnValue = ""; }
});

try {
  getCurrentWebviewWindow().onDragDropEvent((event) => {
    const payload = event.payload;
    document.body.classList.toggle("dragging-image", payload.type === "enter" || payload.type === "over");
    if (payload.type === "drop") importImages(payload.paths || []);
    if (payload.type === "leave") document.body.classList.remove("dragging-image");
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

setSidebarWidth(sidebarWidth, false);
setSidebarCollapsed(localStorage.getItem("mdparcel.sidebar-collapsed") === "true", false);
newDocument().catch((error) => window.alert(`编辑器初始化失败：${error}`));
