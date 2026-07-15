let nextDocumentId = 1;

export function createDocument(data = {}, path = null) {
  const title = data.title ?? "未命名文档";
  const markdown = data.markdown ?? "# 未命名文档\n\n";
  return {
    id: nextDocumentId++,
    path,
    title,
    markdown,
    savedTitle: path ? title : "",
    savedMarkdown: path ? markdown : "",
    assetCount: data.assetCount ?? data.asset_count ?? 0,
    html: data.html ?? "",
    renderVersion: 0,
  };
}

export function isDocumentDirty(document) {
  return document.title !== document.savedTitle || document.markdown !== document.savedMarkdown;
}

export function displayTitle(document) {
  return document.title.trim() || "未命名文档";
}

export function findMatches(text, query, matchCase = false) {
  if (!query) return [];
  const haystack = matchCase ? text : text.toLocaleLowerCase();
  const needle = matchCase ? query : query.toLocaleLowerCase();
  const matches = [];
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    matches.push({ start: offset, end: offset + query.length });
    offset += Math.max(query.length, 1);
  }
  return matches;
}

export function replaceAllLiteral(text, query, replacement, matchCase = false) {
  const matches = findMatches(text, query, matchCase);
  if (!matches.length) return { text, count: 0 };
  let result = "";
  let cursor = 0;
  for (const match of matches) {
    result += text.slice(cursor, match.start) + replacement;
    cursor = match.end;
  }
  return { text: result + text.slice(cursor), count: matches.length };
}

export function markdownImage(archivePath, alt = "图片") {
  const safeAlt = alt.replace(/[\[\]]/g, "").trim() || "图片";
  return `![${safeAlt}](${archivePath})`;
}
