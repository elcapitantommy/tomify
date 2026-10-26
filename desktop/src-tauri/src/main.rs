// Tomify for Windows: the hosted Tomify web app in its own window.
// The app itself stays the website, so updates arrive without reinstalling.
// The only native parts are the window, the mini player mode and opening other sites in the browser.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mini_spot;

use mini_spot::{Area, MINI_HEIGHT, MINI_WIDTH};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, Runtime, Url, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

const APP_URL: &str = "https://app.tomify.tomdixon.uk/";
// Where the mini player was last left, kept in the app's settings folder so it survives restarts.
const MINI_SPOT_FILE: &str = "mini-player-position.txt";
// wry's defaults, plus Chromium's media key handling so the keyboard's play, next and previous keys
// and the Windows media overlay reach Tomify's Media Session controls.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --enable-features=HardwareMediaKeyHandling";

// The full window's size and place, kept while the mini player is showing.
#[derive(Default)]
struct FullWindow(Mutex<Option<(PhysicalPosition<i32>, PhysicalSize<u32>, bool)>>);

fn mini_spot_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(MINI_SPOT_FILE))
}

fn load_mini_spot<R: Runtime>(app: &AppHandle<R>) -> Option<(i32, i32)> {
    mini_spot::parse(&std::fs::read_to_string(mini_spot_path(app)?).ok()?)
}

// Called while the window is the mini player: remembers where it is now. Best effort; a failed save
// only means it opens in the default spot next time.
fn save_mini_spot<R: Runtime>(app: &AppHandle<R>, position: tauri::Result<PhysicalPosition<i32>>, minimized: bool) {
    let Ok(position) = position else { return };
    let spot = (position.x, position.y);
    if minimized || !mini_spot::worth_saving(spot) {
        return;
    }
    if let Some(path) = mini_spot_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, mini_spot::format(spot));
    }
}

fn area(monitor: &Monitor) -> Area {
    let work = monitor.work_area();
    Area {
        x: work.position.x,
        y: work.position.y,
        width: work.size.width as i32,
        height: work.size.height as i32,
        scale: monitor.scale_factor(),
    }
}

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
    // Where it was last left (kept on a screen that is still connected), or the first time
    // the bottom right of the screen the window is on, above the taskbar.
    if let Ok(Some(current)) = window.current_monitor() {
        let areas: Vec<Area> = window.available_monitors().unwrap_or_default().iter().map(area).collect();
        let (x, y) = mini_spot::place(load_mini_spot(window.app_handle()), &area(&current), &areas);
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
    save_mini_spot(window.app_handle(), window.outer_position(), window.is_minimized().unwrap_or(false));
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
        // Closing the app while it is the mini player still remembers where the mini player was.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let mini = window
                    .state::<FullWindow>()
                    .0
                    .lock()
                    .map(|saved| saved.is_some())
                    .unwrap_or(false);
                if mini {
                    save_mini_spot(window.app_handle(), window.outer_position(), window.is_minimized().unwrap_or(false));
                }
            }
        })
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
