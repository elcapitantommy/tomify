fn main() {
    // The Tomify site is remote, so its calls to these commands need permissions (capabilities/tomify-site.json).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["enter_mini_player", "exit_mini_player"]),
    ))
    .expect("failed to run the Tauri build script");
}
