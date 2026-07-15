use std::{
    fs::{self, File},
    io::{Read, Write},
    path::Path,
};

use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use pulldown_cmark::{Options, Parser, html};
use sha2::{Digest, Sha256};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

use crate::{
    manifest::{Asset, FORMAT, Manifest, VERSION},
    markdown,
};

const MAX_ENTRIES: usize = 10_000;
const MAX_UNPACKED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_IMPORTED_ASSET_BYTES: u64 = 100 * 1024 * 1024;

#[derive(serde::Serialize)]
pub struct RenderedDocument {
    pub title: String,
    pub markdown: String,
    pub html: String,
    pub asset_count: usize,
}

pub fn pack(input: &Path, output: &Path, allow_missing: bool, force: bool) -> Result<()> {
    if input.extension().and_then(|x| x.to_str()) != Some("md") {
        bail!("input must be a .md file");
    }
    if output.extension().and_then(|x| x.to_str()) != Some("mdparcel") {
        bail!("output must use the .mdparcel extension");
    }
    if output.exists() && !force {
        bail!("output already exists; use --force to replace it");
    }
    let source = fs::read_to_string(input).context("read Markdown input as UTF-8")?;
    let root = input.parent().unwrap_or(Path::new("."));
    let mut assets = Vec::new();
    let mut missing = Vec::new();
    for original in markdown::local_destinations(&source) {
        let relative = markdown::safe_relative(&original)
            .ok_or_else(|| anyhow!("unsafe local resource path: {original}"))?;
        let file = root.join(&relative);
        if !file.is_file() {
            missing.push(original);
            continue;
        }
        let bytes = fs::read(&file).with_context(|| format!("read {}", file.display()))?;
        let archive_path = format!("assets/{}", relative.to_string_lossy().replace('\\', "/"));
        assets.push((
            Asset {
                archive_path,
                original_path: relative.to_string_lossy().replace('\\', "/"),
                media_type: mime_guess::from_path(&file)
                    .first_or_octet_stream()
                    .to_string(),
                size: bytes.len() as u64,
                sha256: hash(&bytes),
            },
            bytes,
        ));
    }
    if !missing.is_empty() && !allow_missing {
        bail!(
            "referenced resource(s) do not exist: {}",
            missing.join(", ")
        );
    }
    let manifest = Manifest {
        format: FORMAT.into(),
        version: VERSION.into(),
        title: input
            .file_stem()
            .and_then(|x| x.to_str())
            .unwrap_or("Untitled")
            .into(),
        entry: "document.md".into(),
        created_at: chrono_time(),
        generator: format!("mdparcel {}", env!("CARGO_PKG_VERSION")),
        assets: assets
            .iter()
            .map(|(asset, _)| Asset {
                archive_path: asset.archive_path.clone(),
                original_path: asset.original_path.clone(),
                media_type: asset.media_type.clone(),
                size: asset.size,
                sha256: asset.sha256.clone(),
            })
            .collect(),
    };
    let out = File::create(output).with_context(|| format!("create {}", output.display()))?;
    let mut zip = ZipWriter::new(out);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    add(
        &mut zip,
        "manifest.json",
        &serde_json::to_vec_pretty(&manifest)?,
        options,
    )?;
    add(
        &mut zip,
        "document.md",
        markdown::package_paths(&source).as_bytes(),
        options,
    )?;
    for (asset, bytes) in assets {
        add(&mut zip, &asset.archive_path, &bytes, options)?;
    }
    zip.finish()?;
    println!(
        "packed {} asset(s) into {}",
        manifest.assets.len(),
        output.display()
    );
    for path in missing {
        eprintln!("warning: missing resource: {path}");
    }
    Ok(())
}

pub fn info(input: &Path) -> Result<()> {
    let manifest = read_manifest(input)?;
    println!(
        "Title: {}\nFormat: {} {}\nEntry: {}\nCreated: {}\nAssets: {}",
        manifest.title,
        manifest.format,
        manifest.version,
        manifest.entry,
        manifest.created_at,
        manifest.assets.len()
    );
    Ok(())
}

pub fn check(input: &Path) -> Result<()> {
    let file = File::open(input)?;
    let mut zip = ZipArchive::new(file).context("not a valid ZIP archive")?;
    enforce_limits(&mut zip)?;
    let manifest = manifest_from_zip(&mut zip)?;
    validate_manifest(&manifest)?;
    let mut document = String::new();
    zip.by_name(&manifest.entry)?
        .read_to_string(&mut document)?;
    for asset in &manifest.assets {
        safe_archive_path(&asset.archive_path)?;
        let mut bytes = Vec::new();
        zip.by_name(&asset.archive_path)
            .with_context(|| format!("missing asset {}", asset.archive_path))?
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 != asset.size || hash(&bytes) != asset.sha256 {
            bail!("asset integrity check failed: {}", asset.archive_path);
        }
    }
    for path in markdown::local_destinations(&document) {
        let name = if let Some(inner) = path.strip_prefix("assets/") {
            let clean = markdown::safe_relative(inner)
                .ok_or_else(|| anyhow!("unsafe document asset path: {path}"))?;
            format!("assets/{}", clean.to_string_lossy().replace('\\', "/"))
        } else {
            format!("assets/{path}")
        };
        if zip.by_name(&name).is_err() {
            bail!("document references missing asset: {name}");
        }
    }
    println!(
        "OK: valid MDParcel 1.0 package with {} asset(s)",
        manifest.assets.len()
    );
    Ok(())
}

pub fn unpack(input: &Path, output: &Path, force: bool) -> Result<()> {
    if output.exists() && !force {
        bail!("output already exists; use --force to replace files inside it");
    }
    check(input)?;
    let file = File::open(input)?;
    let mut zip = ZipArchive::new(file)?;
    let manifest = manifest_from_zip(&mut zip)?;
    fs::create_dir_all(output)?;
    let mut document = String::new();
    zip.by_name(&manifest.entry)?
        .read_to_string(&mut document)?;
    let name = format!("{}.md", safe_file_name(&manifest.title));
    fs::write(output.join(name), markdown::restore_paths(&document))?;
    for asset in &manifest.assets {
        let destination = output.join(&asset.original_path);
        ensure_inside(output, &destination)?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut data = Vec::new();
        zip.by_name(&asset.archive_path)?.read_to_end(&mut data)?;
        fs::write(destination, data)?;
    }
    println!(
        "unpacked {} asset(s) to {}",
        manifest.assets.len(),
        output.display()
    );
    Ok(())
}

/// Directly renders a package without requiring the user to unpack it.
pub fn view(input: &Path, open_browser: bool) -> Result<()> {
    let preview = create_preview(input)?;
    let index = preview.join("index.html");
    println!("preview generated: {}", index.display());
    if open_browser {
        open_in_browser(&index)?;
    }
    Ok(())
}

/// Renders an archive for an embedded viewer. Package images become data URLs,
/// so the caller does not need filesystem access to temporary asset files.
pub fn render_document(input: &Path) -> Result<RenderedDocument> {
    check(input)?;
    let (manifest, markdown, assets) = read_package_content(input)?;
    let body = render_markdown_with_assets(&markdown, &assets);
    Ok(RenderedDocument {
        title: manifest.title,
        markdown,
        html: body,
        asset_count: assets.len(),
    })
}

/// Renders Markdown being edited in the GUI. When a source package is supplied,
/// its images are embedded as data URLs for a self-contained preview.
pub fn render_markdown(markdown: &str, source: Option<&Path>) -> Result<String> {
    let assets = if let Some(path) = source.filter(|path| path.is_file()) {
        let (_, _, assets) = read_package_content(path)?;
        assets
    } else {
        Vec::new()
    };
    Ok(render_markdown_with_assets(markdown, &assets))
}

/// Creates or updates an MDParcel while preserving the source package assets.
pub fn save_document(
    source: Option<&Path>,
    target: &Path,
    title: &str,
    markdown: &str,
) -> Result<()> {
    ensure_mdparcel_extension(target)?;
    let (created_at, assets) = if let Some(path) = source.filter(|path| path.is_file()) {
        let (manifest, _, assets) = read_package_content(path)?;
        (manifest.created_at, assets)
    } else {
        (chrono_time(), Vec::new())
    };
    let title = if title.trim().is_empty() {
        target
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Untitled")
    } else {
        title.trim()
    };
    write_editable_package(target, title, markdown, created_at, assets)
}

/// Imports an image into an existing package and returns its archive-relative path.
pub fn import_asset(package: &Path, source_file: &Path) -> Result<String> {
    if !source_file.is_file() {
        bail!("imported asset is not a file: {}", source_file.display());
    }
    let media_type = mime_guess::from_path(source_file)
        .first_or_octet_stream()
        .to_string();
    if !media_type.starts_with("image/") {
        bail!("only image files can be imported");
    }
    let size = fs::metadata(source_file)?.len();
    if size > MAX_IMPORTED_ASSET_BYTES {
        bail!("image is larger than the 100 MiB import limit");
    }
    let bytes = fs::read(source_file)
        .with_context(|| format!("read imported asset {}", source_file.display()))?;
    let original_name = source_file
        .file_name()
        .and_then(|value| value.to_str())
        .context("asset filename must be valid UTF-8")?;
    import_asset_data(package, original_name, &media_type, bytes)
}

/// Imports an image received from the system clipboard without requiring a
/// temporary filesystem path.
pub fn import_asset_bytes(
    package: &Path,
    filename: &str,
    media_type: &str,
    bytes: Vec<u8>,
) -> Result<String> {
    if !media_type.starts_with("image/") {
        bail!("clipboard data is not an image");
    }
    if bytes.len() as u64 > MAX_IMPORTED_ASSET_BYTES {
        bail!("image is larger than the 100 MiB import limit");
    }
    import_asset_data(package, filename, media_type, bytes)
}

fn import_asset_data(
    package: &Path,
    requested_filename: &str,
    media_type: &str,
    bytes: Vec<u8>,
) -> Result<String> {
    let (manifest, markdown, mut assets) = read_package_content(package)?;
    let original_name = Path::new(requested_filename)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("pasted-image.png");
    let source_name = Path::new(original_name);
    let stem = source_name
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let extension = source_name
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let mut filename = original_name.to_owned();
    let mut suffix = 2;
    while assets
        .iter()
        .any(|(asset, _)| asset.archive_path == format!("assets/{filename}"))
    {
        filename = format!("{stem}-{suffix}{extension}");
        suffix += 1;
    }
    let archive_path = format!("assets/{filename}");
    assets.push((
        Asset {
            archive_path: archive_path.clone(),
            original_path: filename,
            media_type: media_type.to_owned(),
            size: bytes.len() as u64,
            sha256: hash(&bytes),
        },
        bytes,
    ));
    write_editable_package(
        package,
        &manifest.title,
        &markdown,
        manifest.created_at,
        assets,
    )?;
    Ok(archive_path)
}

fn render_markdown_with_assets(markdown: &str, assets: &[(Asset, Vec<u8>)]) -> String {
    let mut body = String::new();
    html::push_html(&mut body, Parser::new_ext(&markdown, Options::all()));
    for (asset, bytes) in assets {
        if !asset.media_type.starts_with("image/") {
            continue;
        }
        let data_url = format!(
            "data:{};base64,{}",
            asset.media_type,
            STANDARD.encode(bytes)
        );
        body = body.replace(
            &format!("src=\"{}\"", asset.archive_path),
            &format!("data-md-src=\"{}\" src=\"{data_url}\"", asset.archive_path),
        );
    }
    body
}

fn create_preview(input: &Path) -> Result<std::path::PathBuf> {
    check(input)?;
    let mut zip = ZipArchive::new(File::open(input)?)?;
    let manifest = manifest_from_zip(&mut zip)?;
    let preview = std::env::temp_dir().join(format!(
        "mdparcel-preview-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::create_dir_all(&preview)?;
    for asset in &manifest.assets {
        let target = preview.join(&asset.archive_path);
        ensure_inside(&preview, &target)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut data = Vec::new();
        zip.by_name(&asset.archive_path)?.read_to_end(&mut data)?;
        fs::write(target, data)?;
    }
    let mut markdown = String::new();
    zip.by_name(&manifest.entry)?
        .read_to_string(&mut markdown)?;
    let mut body = String::new();
    html::push_html(&mut body, Parser::new_ext(&markdown, Options::all()));
    let page = format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>{}</title><style>{}</style></head><body><main>{}</main></body></html>",
        escape_html(&manifest.title),
        PREVIEW_STYLE,
        body
    );
    fs::write(preview.join("index.html"), page)?;
    Ok(preview)
}

#[cfg(target_os = "windows")]
fn open_in_browser(path: &Path) -> Result<()> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &path.to_string_lossy()])
        .spawn()
        .context("open preview in the default browser")?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_in_browser(path: &Path) -> Result<()> {
    std::process::Command::new("open").arg(path).spawn()?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_in_browser(path: &Path) -> Result<()> {
    std::process::Command::new("xdg-open").arg(path).spawn()?;
    Ok(())
}

const PREVIEW_STYLE: &str = r#"
body { margin: 0; background: #f7f7f8; color: #202124; font: 16px/1.7 system-ui, sans-serif; }
main { box-sizing: border-box; max-width: 920px; min-height: 100vh; margin: auto; padding: 48px; background: white; }
img { max-width: 100%; height: auto; } pre { overflow: auto; padding: 16px; background: #f1f3f5; border-radius: 6px; }
code { font-family: ui-monospace, Consolas, monospace; } blockquote { margin-left: 0; padding-left: 16px; border-left: 4px solid #d0d7de; color: #57606a; }
table { border-collapse: collapse; } th, td { padding: 6px 12px; border: 1px solid #d0d7de; }
"#;

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\"', "&quot;")
}

fn ensure_mdparcel_extension(path: &Path) -> Result<()> {
    if path.extension().and_then(|value| value.to_str()) != Some("mdparcel") {
        bail!("file must use the .mdparcel extension");
    }
    Ok(())
}

fn read_package_content(path: &Path) -> Result<(Manifest, String, Vec<(Asset, Vec<u8>)>)> {
    let mut zip = ZipArchive::new(File::open(path)?)?;
    enforce_limits(&mut zip)?;
    let manifest = manifest_from_zip(&mut zip)?;
    validate_manifest(&manifest)?;
    let mut markdown = String::new();
    zip.by_name(&manifest.entry)?
        .read_to_string(&mut markdown)?;
    let mut assets = Vec::with_capacity(manifest.assets.len());
    for asset in &manifest.assets {
        safe_archive_path(&asset.archive_path)?;
        let mut bytes = Vec::new();
        zip.by_name(&asset.archive_path)
            .with_context(|| format!("missing asset {}", asset.archive_path))?
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 != asset.size || hash(&bytes) != asset.sha256 {
            bail!("asset integrity check failed: {}", asset.archive_path);
        }
        assets.push((asset.clone(), bytes));
    }
    Ok((manifest, markdown, assets))
}

fn write_editable_package(
    target: &Path,
    title: &str,
    markdown: &str,
    created_at: String,
    assets: Vec<(Asset, Vec<u8>)>,
) -> Result<()> {
    ensure_mdparcel_extension(target)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = target.with_extension("mdparcel.tmp");
    let manifest = Manifest {
        format: FORMAT.into(),
        version: VERSION.into(),
        title: title.to_owned(),
        entry: "document.md".into(),
        created_at,
        generator: format!("mdparcel {}", env!("CARGO_PKG_VERSION")),
        assets: assets.iter().map(|(asset, _)| asset.clone()).collect(),
    };
    let out = File::create(&temporary)
        .with_context(|| format!("create temporary package {}", temporary.display()))?;
    let mut zip = ZipWriter::new(out);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    add(
        &mut zip,
        "manifest.json",
        &serde_json::to_vec_pretty(&manifest)?,
        options,
    )?;
    add(&mut zip, "document.md", markdown.as_bytes(), options)?;
    for (asset, bytes) in assets {
        add(&mut zip, &asset.archive_path, &bytes, options)?;
    }
    zip.finish()?;
    if target.exists() {
        fs::remove_file(target)
            .with_context(|| format!("replace existing package {}", target.display()))?;
    }
    fs::rename(&temporary, target)
        .with_context(|| format!("finish package {}", target.display()))?;
    Ok(())
}

fn add(
    zip: &mut ZipWriter<File>,
    name: &str,
    data: &[u8],
    options: SimpleFileOptions,
) -> Result<()> {
    zip.start_file(name, options)?;
    zip.write_all(data)?;
    Ok(())
}
fn read_manifest(input: &Path) -> Result<Manifest> {
    let mut zip = ZipArchive::new(File::open(input)?)?;
    manifest_from_zip(&mut zip)
}
fn manifest_from_zip(zip: &mut ZipArchive<File>) -> Result<Manifest> {
    let mut text = String::new();
    zip.by_name("manifest.json")
        .context("missing manifest.json")?
        .read_to_string(&mut text)?;
    Ok(serde_json::from_str(&text).context("invalid manifest.json")?)
}
fn validate_manifest(m: &Manifest) -> Result<()> {
    if m.format != FORMAT || m.version != VERSION || m.entry != "document.md" {
        bail!("unsupported MDParcel manifest");
    }
    Ok(())
}
fn enforce_limits(zip: &mut ZipArchive<File>) -> Result<()> {
    if zip.len() > MAX_ENTRIES {
        bail!("too many archive entries");
    }
    let total = (0..zip.len()).try_fold(0u64, |sum, i| -> Result<u64> {
        let item = zip.by_index(i)?;
        safe_archive_path(item.name())?;
        Ok(sum + item.size())
    })?;
    if total > MAX_UNPACKED_BYTES {
        bail!("archive expands beyond allowed size");
    }
    Ok(())
}
fn safe_archive_path(path: &str) -> Result<()> {
    if markdown::safe_relative(path).is_none() {
        bail!("unsafe archive path: {path}");
    }
    Ok(())
}
fn ensure_inside(root: &Path, target: &Path) -> Result<()> {
    if !target.starts_with(root) {
        bail!("unsafe output path");
    }
    Ok(())
}
fn hash(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
fn safe_file_name(value: &str) -> String {
    value
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_check_and_unpack_round_trip() -> Result<()> {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mdparcel-test-{id}"));
        let input_dir = root.join("input");
        fs::create_dir_all(input_dir.join("images"))?;
        fs::write(input_dir.join("images/logo.png"), b"fake png")?;
        fs::write(
            input_dir.join("note.md"),
            "# Note\n\n![Logo](images/logo.png)\n[Attachment](images/logo.png)\n",
        )?;
        let package = root.join("note.mdparcel");
        pack(&input_dir.join("note.md"), &package, false, false)?;
        check(&package)?;
        let restored = root.join("restored");
        unpack(&package, &restored, false)?;
        assert!(restored.join("images/logo.png").is_file());
        let recovered = fs::read_to_string(restored.join("note.md"))?;
        assert!(recovered.contains("images/logo.png"));
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn preview_contains_rendered_html_and_asset() -> Result<()> {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mdparcel-view-test-{id}"));
        fs::create_dir_all(root.join("images"))?;
        fs::write(root.join("images/logo.png"), b"fake png")?;
        fs::write(
            root.join("note.md"),
            "# Preview\n\n![Logo](images/logo.png)",
        )?;
        let package = root.join("note.mdparcel");
        pack(&root.join("note.md"), &package, false, false)?;
        let preview = create_preview(&package)?;
        assert!(preview.join("assets/images/logo.png").is_file());
        assert!(fs::read_to_string(preview.join("index.html"))?.contains("<h1>Preview</h1>"));
        fs::remove_dir_all(root)?;
        fs::remove_dir_all(preview)?;
        Ok(())
    }

    #[test]
    fn editable_document_can_be_saved_and_reopened() -> Result<()> {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mdparcel-edit-test-{id}"));
        fs::create_dir_all(&root)?;
        let package = root.join("edited.mdparcel");
        save_document(None, &package, "Edited note", "# Edited\n\nHello")?;
        let document = render_document(&package)?;
        assert_eq!(document.title, "Edited note");
        assert_eq!(document.markdown, "# Edited\n\nHello");
        assert!(document.html.contains("<h1>Edited</h1>"));
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn imported_image_is_preserved_when_document_is_saved() -> Result<()> {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mdparcel-asset-test-{id}"));
        fs::create_dir_all(&root)?;
        let package = root.join("image.mdparcel");
        let image = root.join("photo.png");
        fs::write(&image, b"fake png")?;
        save_document(None, &package, "Image note", "# Image")?;
        let archive_path = import_asset(&package, &image)?;
        let markdown = format!("# Image\n\n![Photo]({archive_path})");
        save_document(Some(&package), &package, "Image note", &markdown)?;
        let document = render_document(&package)?;
        assert_eq!(document.asset_count, 1);
        assert!(document.html.contains("data:image/png;base64,"));
        assert!(document.html.contains("data-md-src=\"assets/photo.png\""));
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn importing_duplicate_names_creates_unique_archive_paths() -> Result<()> {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mdparcel-duplicate-asset-test-{id}"));
        fs::create_dir_all(root.join("first"))?;
        fs::create_dir_all(root.join("second"))?;
        let package = root.join("images.mdparcel");
        fs::write(root.join("first/photo.png"), b"first")?;
        fs::write(root.join("second/photo.png"), b"second")?;
        save_document(None, &package, "Images", "# Images")?;
        assert_eq!(
            import_asset(&package, &root.join("first/photo.png"))?,
            "assets/photo.png"
        );
        assert_eq!(
            import_asset(&package, &root.join("second/photo.png"))?,
            "assets/photo-2.png"
        );
        assert_eq!(render_document(&package)?.asset_count, 2);
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn non_image_assets_are_rejected_by_the_editor_import() -> Result<()> {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mdparcel-invalid-asset-test-{id}"));
        fs::create_dir_all(&root)?;
        let package = root.join("note.mdparcel");
        let text = root.join("notes.txt");
        fs::write(&text, b"not an image")?;
        save_document(None, &package, "Note", "# Note")?;
        let error = import_asset(&package, &text).unwrap_err().to_string();
        assert!(error.contains("only image files"));
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn clipboard_image_bytes_are_written_into_the_package() -> Result<()> {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mdparcel-clipboard-test-{id}"));
        fs::create_dir_all(&root)?;
        let package = root.join("clipboard.mdparcel");
        save_document(None, &package, "Clipboard", "# Clipboard")?;
        let path = import_asset_bytes(
            &package,
            "Clipboard Image.png",
            "image/png",
            b"clipboard png".to_vec(),
        )?;
        assert_eq!(path, "assets/Clipboard Image.png");
        let document = render_document(&package)?;
        assert_eq!(document.asset_count, 1);
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
fn chrono_time() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}
