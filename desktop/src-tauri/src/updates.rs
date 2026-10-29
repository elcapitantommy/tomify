// Keeping the app itself up to date. The site updates on every deploy anyway; this is for the
// window around it. The check runs here in Rust, so the site gets no updater access at all.
//
// GitHub Actions publishes each new app version as a release with signed installers and a
// latest.json (see .github/workflows/desktop.yml). The app reads it on start and every few hours,
// asks before installing, and Windows' installer then reopens the app on the new version.

use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Wait a little after starting so the first check doesn't compete with Tomify loading.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(15);
/// The app is often left open for days as a music player, so it looks again now and then.
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// The version already offered in this run, so "Later" isn't asked again until the app restarts
/// or a newer version comes out.
#[derive(Default)]
pub struct Offered(Mutex<Option<String>>);

/// Builds without the updater's public key (any build made outside GitHub Actions with the signing
/// secrets set) can't verify an update, so they don't look for one.
pub fn enabled(pubkey: Option<&str>) -> bool {
    pubkey.is_some_and(|key| !key.trim().is_empty())
}

pub fn worth_offering(offered: Option<&str>, version: &str) -> bool {
    offered != Some(version)
}

pub fn question(current: &str, version: &str) -> String {
    format!(
        "Tomify for Windows {version} is available (you have {current}).\n\n\
         Install it now? Tomify closes for a few seconds while it updates and then opens again. \
         Your sign-in, downloads and settings are kept."
    )
}

fn configured_pubkey<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let updater = app.config().plugins.0.get("updater")?;
    updater.get("pubkey")?.as_str().map(str::to_owned)
}

/// Starts the background checks. Does nothing in a build that can't verify updates.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if !enabled(configured_pubkey(app).as_deref()) {
        return;
    }
    app.manage(Offered::default());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_AFTER).await;
        loop {
            // A failed check (offline, GitHub down) just waits for the next one.
            if let Ok(Some(update)) = check(&app).await {
                offer(&app, update);
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

async fn check<R: Runtime>(app: &AppHandle<R>) -> tauri_plugin_updater::Result<Option<Update>> {
    app.updater()?.check().await
}

fn offer<R: Runtime>(app: &AppHandle<R>, update: Update) {
    {
        let state = app.state::<Offered>();
        let Ok(mut offered) = state.0.lock() else { return };
        if !worth_offering(offered.as_deref(), &update.version) {
            return;
        }
        *offered = Some(update.version.clone());
    }
    let mut dialog = app
        .dialog()
        .message(question(&update.current_version, &update.version))
        .title("Update Tomify")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Update now".into(), "Later".into()));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    let app = app.clone();
    dialog.show(move |yes| {
        if !yes {
            return;
        }
        tauri::async_runtime::spawn(async move {
            // On Windows this starts the installer and closes the app; the installer reopens it.
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(()) => app.restart(),
                Err(error) => {
                    app.dialog()
                        .message(format!("Tomify couldn't install the update: {error}\n\nIt will offer it again next time Tomify starts."))
                        .title("Update Tomify")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_build_with_the_public_key_checks_for_updates() {
        assert!(enabled(Some("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk=")));
        assert!(!enabled(Some("")));
        assert!(!enabled(Some("  ")));
        assert!(!enabled(None));
    }

    #[test]
    fn later_is_not_asked_again_for_the_same_version() {
        assert!(worth_offering(None, "0.1.4"));
        assert!(!worth_offering(Some("0.1.4"), "0.1.4"));
        assert!(worth_offering(Some("0.1.4"), "0.1.5"));
    }

    #[test]
    fn the_question_names_both_versions() {
        let text = question("0.1.3", "0.1.4");
        assert!(text.contains("0.1.4 is available (you have 0.1.3)"));
        assert!(text.contains("opens again"));
    }
}
