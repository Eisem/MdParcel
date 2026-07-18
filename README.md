# MDParcel

MDParcel is a portable Markdown document package. An `.mdparcel` file is a ZIP archive
containing a Markdown entry document, its local assets, and a JSON manifest.

## Commands

```powershell
mdparcel pack .\notes\rust.md -o .\rust-notes.mdparcel
mdparcel info .\rust-notes.mdparcel
mdparcel check .\rust-notes.mdparcel
mdparcel unpack .\rust-notes.mdparcel -o .\restored-notes
mdparcel export .\rust-notes.mdparcel -o .\rust-notes.zip
```

## Desktop editor

The `desktop/` directory contains a Tauri desktop editor. Version 0.3 embeds
Vditor's IR (instant-rendering) editing engine as a continuous, borderless
document surface: the active block exposes its Markdown markers while the rest
of the document stays rendered. Vditor's web toolbar is hidden and its formatting
commands are integrated into the application's top Edit menu. All Vditor assets
are bundled locally, so editing does not require a CDN or internet connection.

The editor also supports multiple document tabs, unsaved-state indicators,
find/replace/replace-all, and image imports from the picker, drag-and-drop, or
the clipboard. Imported images are stored inside the active `.mdparcel` archive.
Use **文件 → 导出 ZIP…** to create a conventional ZIP containing `document.md`
and a `src/` folder; resource links in the exported Markdown are rewritten to
`src/...` automatically.

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
