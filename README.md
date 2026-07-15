# MDParcel

MDParcel is a portable Markdown document package. An `.mdparcel` file is a ZIP archive
containing a Markdown entry document, its local assets, and a JSON manifest.

## Commands

```powershell
mdparcel pack .\notes\rust.md -o .\rust-notes.mdparcel
mdparcel info .\rust-notes.mdparcel
mdparcel check .\rust-notes.mdparcel
mdparcel unpack .\rust-notes.mdparcel -o .\restored-notes
```

## Desktop editor

The `desktop/` directory contains a Tauri desktop editor. Version 0.2 supports
multiple document tabs with per-document unsaved state, find/replace/replace-all,
image picker and drag-and-drop imports, and bidirectional Markdown/WYSIWYG editing.
Imported images are stored inside the active `.mdparcel` archive.

```powershell
cd .\desktop
npm install
npm run dev
npm test
```

Build Windows installers with:

```powershell
npm run build
```

The package format stores local Markdown image and link destinations. Remote
URLs and anchors are left unchanged. Paths must stay inside the entry document
directory.

## Archive layout

```text
manifest.json
document.md
assets/<original relative resource path>
```
