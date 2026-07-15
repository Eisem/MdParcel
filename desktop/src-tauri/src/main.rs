use mdparcel::archive;
use std::path::Path;

#[tauri::command]
fn open_package(path: String) -> Result<archive::RenderedDocument, String> {
    archive::render_document(path.as_ref()).map_err(|error| error.to_string())
}

#[tauri::command]
fn render_markdown(markdown: String, source_path: Option<String>) -> Result<String, String> {
    archive::render_markdown(
        &markdown,
        source_path.as_deref().map(Path::new),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_package(
    source_path: Option<String>,
    target_path: String,
    title: String,
    markdown: String,
) -> Result<(), String> {
    archive::save_document(
        source_path.as_deref().map(Path::new),
        Path::new(&target_path),
        &title,
        &markdown,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn import_asset(package_path: String, asset_path: String) -> Result<String, String> {
    archive::import_asset(Path::new(&package_path), Path::new(&asset_path))
        .map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_package,
            render_markdown,
            save_package,
            import_asset
        ])
        .run(tauri::generate_context!())
        .expect("failed to run MDParcel desktop reader");
}
