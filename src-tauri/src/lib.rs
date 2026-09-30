#[tauri::command]
fn core_version() -> &'static str {
    mosaic_core::VERSION
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![core_version])
        .run(tauri::generate_context!())
        .expect("error while running Mosaic");
}
