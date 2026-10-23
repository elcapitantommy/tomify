// Tomify for Windows: the hosted Tomify web app in its own window.
// The app itself stays the website, so updates arrive without reinstalling.
// The only native parts are the window, the mini player mode and opening other sites in the browser.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const APP_URL: &str = "https://app.tomify.tomdixon.uk/";
const MINI_WIDTH: f64 = 360.0;
const MINI_HEIGHT: f64 = 168.0;
const MINI_MARGIN: i32 = 16;
// wry's defaults, plus Chromium's media key handling so the keyboard's play, next and previous keys
// and the Windows media overlay reach Tomify's Media Session controls.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --enable-features=HardwareMediaKeyHandling";

// The full window's size and place, kept while the mini player is showing.
#[derive(Default)]
struct FullWindow(Mutex<Option<(PhysicalPosition<i32>, PhysicalSize<u32>, bool)>>);

fn same_site(url: &Url) -> bool {
    Url::parse(APP_URL).map(|app| app.origin() == url.origin()).unwrap_or(false)
}

#[tauri::command]
fn enter_mini_player(window: WebviewWindow, saved: tauri::State<FullWindow>) -> Result<(), String> {
    let mut saved = saved.0.lock().map_err(|e| e.to_string())?;
    if saved.is_none() {
        let maximized = window.is_maximized().unwrap_or(false);
        if maximized {
            window.unmaximize().map_err(|e| e.to_string())?;
        }
        *saved = Some((
            window.outer_position().map_err(|e| e.to_string())?,
            window.inner_size().map_err(|e| e.to_string())?,
            maximized,
        ));
    }
    window.set_min_size(None::<LogicalSize<f64>>).map_err(|e| e.to_string())?;
    window.set_decorations(false).map_err(|e| e.to_string())?;
    window.set_resizable(false).map_err(|e| e.to_string())?;
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    window
        .set_size(LogicalSize::new(MINI_WIDTH, MINI_HEIGHT))
        .map_err(|e| e.to_string())?;
    // Bottom right of the screen the window is on, above the taskbar.
    if let Ok(Some(monitor)) = window.current_monitor() {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let width = (MINI_WIDTH * scale) as i32;
        let height = (MINI_HEIGHT * scale) as i32;
        let margin = (MINI_MARGIN as f64 * scale) as i32;
        let x = area.position.x + area.size.width as i32 - width - margin;
        let y = area.position.y + area.size.height as i32 - height - margin;
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn exit_mini_player(window: WebviewWindow, saved: tauri::State<FullWindow>) -> Result<(), String> {
    // Tomify asks for this on every page load; only a window that is the mini player changes.
    let Some((position, size, maximized)) = saved.0.lock().map_err(|e| e.to_string())?.take() else {
        return Ok(());
    };
    window.set_always_on_top(false).map_err(|e| e.to_string())?;
    window.set_decorations(true).map_err(|e| e.to_string())?;
    window.set_resizable(true).map_err(|e| e.to_string())?;
    window
        .set_min_size(Some(LogicalSize::new(480.0, 360.0)))
        .map_err(|e| e.to_string())?;
    window.set_size(size).map_err(|e| e.to_string())?;
    window.set_position(position).map_err(|e| e.to_string())?;
    if maximized {
        window.maximize().map_err(|e| e.to_string())?;
    }
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

fn open_main_window(app: &AppHandle) -> tauri::Result<()> {
    let url = Url::parse(APP_URL).expect("APP_URL is a valid URL");
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Tomify")
        .inner_size(1280.0, 820.0)
        .min_inner_size(480.0, 360.0)
        .center()
        .additional_browser_args(BROWSER_ARGS)
        // Links to other sites (MusicBrainz, Radio Browser) open in the normal browser.
        .on_new_window(move |url, _features| {
            if same_site(&url) {
                return NewWindowResponse::Allow;
            }
            if matches!(url.scheme(), "http" | "https" | "mailto") {
                let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // Starting Tomify again brings the open window forward instead of a second player.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(FullWindow::default())
        .invoke_handler(tauri::generate_handler![enter_mini_player, exit_mini_player])
        .setup(|app| {
            open_main_window(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Tomify");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_tomify_counts_as_the_same_site() {
        assert!(same_site(&Url::parse("https://app.tomify.tomdixon.uk/albums").unwrap()));
        assert!(!same_site(&Url::parse("https://musicbrainz.org/release-group/1").unwrap()));
        assert!(!same_site(&Url::parse("https://app.tomify.tomdixon.uk.evil.example/").unwrap()));
        assert!(!same_site(&Url::parse("http://app.tomify.tomdixon.uk/").unwrap()));
    }
}
