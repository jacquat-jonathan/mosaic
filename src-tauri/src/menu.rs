//! The macOS menu bar: Mosaic, File, Edit, View, Window and Help.
//!
//! Most items run a command from the UI's registry (`ui/src/commands.ts`): the item's id is the
//! command id, and choosing it emits [`MENU_COMMAND_EVENT`] to the window, which runs the command the
//! same way the palette does. Their shortcuts come from the UI too (`sync_menu`), so a shortcut
//! changed in Settings › Shortcuts shows, and works, in the menu. The web view sees a key first: a
//! shortcut the UI handles never reaches the menu, so nothing runs twice.
//!
//! Other platforms keep Tauri's default (no menu bar on Windows and Linux); `sync_menu` does nothing
//! there.

use serde::Deserialize;
use specta::Type;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

/// The event a chosen command item sends to the window; the payload is the command id.
pub(crate) const MENU_COMMAND_EVENT: &str = "menu-command";
const GITHUB_URL: &str = "https://github.com/jacquat-jonathan/mosaic";

/// Items AppKit (through muda) implements itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Native {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Zoom,
    BringAllToFront,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Entry {
    /// A UI command: (command id, menu title).
    Command(&'static str, &'static str),
    /// Handled here: (id, title, accelerator).
    App(&'static str, &'static str, Option<&'static str>),
    Native(Native),
    Separator,
}

use Entry::{App, Command, Separator};

const CLOSE_WINDOW: &str = "close-window";
const OPEN_GITHUB: &str = "open-github";

/// The whole menu bar, as data. macOS titles the first menu with the app's name whatever it's called here.
pub(crate) const LAYOUT: &[(&str, &[Entry])] = &[
    (
        "Mosaic",
        &[
            Entry::Native(Native::About),
            Separator,
            Command("settings", "Settings…"),
            Command("check-updates", "Check for Updates…"),
            Separator,
            Entry::Native(Native::Services),
            Separator,
            Entry::Native(Native::Hide),
            Entry::Native(Native::HideOthers),
            Entry::Native(Native::ShowAll),
            Separator,
            Entry::Native(Native::Quit),
        ],
    ),
    (
        "File",
        &[
            Command("new-note", "New Note"),
            Command("new-folder", "New Folder"),
            Command("daily-note", "Open Today’s Daily Note"),
            Separator,
            Command("switcher", "Quick Open…"),
            Command("open-vault", "Open Vault…"),
            Command("create-vault", "Create Vault…"),
            Separator,
            Command("save", "Save"),
            Command("export-html", "Export as HTML…"),
            Command("export-pdf", "Export as PDF…"),
            Separator,
            Command("close-tab", "Close Tab"),
            // Not the native Close Window: that one takes ⌘W, which is Close Tab here.
            App(CLOSE_WINDOW, "Close Window", Some("Cmd+Shift+KeyW")),
        ],
    ),
    (
        "Edit",
        &[
            Entry::Native(Native::Undo),
            Entry::Native(Native::Redo),
            Separator,
            Entry::Native(Native::Cut),
            Entry::Native(Native::Copy),
            Entry::Native(Native::Paste),
            Entry::Native(Native::SelectAll),
            Separator,
            // ⌘F stays with the editor's find-in-note.
            Command("search", "Search in All Files…"),
        ],
    ),
    (
        "View",
        &[
            Command("destination-notes", "Notes"),
            Command("destination-find", "Find"),
            Command("destination-plan", "Plan"),
            Command("destination-ai", "AI"),
            Separator,
            Command("calendar", "Calendar"),
            Command("chat", "Chat with Claude"),
            Command("palette", "Command Palette…"),
            Separator,
            Command("toggle-left", "Toggle Sidebar"),
            Command("toggle-right", "Toggle Context Panel"),
            Command("split-right", "Split Right"),
            Command("split-down", "Split Down"),
            Separator,
            Command("zoom-in", "Zoom In"),
            Command("zoom-out", "Zoom Out"),
            Command("zoom-reset", "Actual Size"),
            Separator,
            Entry::Native(Native::Fullscreen),
        ],
    ),
    (
        "Window",
        &[
            Entry::Native(Native::Minimize),
            Entry::Native(Native::Zoom),
            Separator,
            Entry::Native(Native::BringAllToFront),
        ],
    ),
    (
        "Help",
        &[
            Command("feedback", "Send Feedback…"),
            Command("shortcuts", "Keyboard Shortcuts"),
            Separator,
            App(OPEN_GITHUB, "Mosaic on GitHub", None),
        ],
    ),
];

/// The UI commands the menu runs, in menu order; exported to the UI as `MENU_COMMANDS`.
pub(crate) fn command_ids() -> Vec<&'static str> {
    LAYOUT
        .iter()
        .flat_map(|(_, entries)| entries.iter())
        .filter_map(|entry| match entry {
            Command(id, _) => Some(*id),
            _ => None,
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
enum Action<'a> {
    RunCommand(&'a str),
    CloseWindow,
    OpenUrl(&'static str),
    Ignore,
}

fn action(id: &str) -> Action<'_> {
    match id {
        CLOSE_WINDOW => Action::CloseWindow,
        OPEN_GITHUB => Action::OpenUrl(GITHUB_URL),
        _ if command_ids().contains(&id) => Action::RunCommand(id),
        // Native items never get here; anything else isn't ours.
        _ => Action::Ignore,
    }
}

/// Runs a chosen menu item (registered on every platform; only macOS has the items).
pub(crate) fn on_event(app: &AppHandle, id: &str) {
    match action(id) {
        Action::RunCommand(command) => {
            let _ = app.emit_to("main", MENU_COMMAND_EVENT, command);
        }
        // close(), not destroy(): CloseRequested still saves the window's place.
        Action::CloseWindow => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        }
        Action::OpenUrl(url) => {
            let _ = app.opener().open_url(url, None::<&str>);
        }
        Action::Ignore => {}
    }
}

/// The command items, by id, so `sync_menu` can change them. Empty off macOS.
#[derive(Default)]
pub(crate) struct MenuState(Mutex<HashMap<String, tauri::menu::MenuItem<tauri::Wry>>>);

/// What the UI says about one command item.
#[derive(Debug, Deserialize, Type)]
pub(crate) struct MenuItemSync {
    id: String,
    /// Like "Cmd+Shift+KeyN" (key part is a `KeyboardEvent.code`); none removes the shortcut.
    accelerator: Option<String>,
    /// Whether the command can run now (e.g. most need a vault).
    enabled: bool,
}

/// A menu shortcut must hold ⌘: one without it would take that key from text the user types.
fn usable_accelerator(accelerator: Option<&str>) -> Option<&str> {
    let accelerator = accelerator?;
    let mut parts: Vec<&str> = accelerator.split('+').map(str::trim).collect();
    parts.pop().filter(|key| !key.is_empty())?;
    parts
        .iter()
        .any(|m| {
            matches!(
                m.to_ascii_uppercase().as_str(),
                "CMD" | "COMMAND" | "SUPER" | "META" | "CMDORCTRL" | "COMMANDORCONTROL"
            )
        })
        .then_some(accelerator)
}

/// Updates the menu's command items: their shortcuts (from Settings › Shortcuts) and whether they
/// can run. Ids that aren't menu items are skipped; does nothing where there's no menu bar.
#[tauri::command(async)]
#[specta::specta]
pub(crate) fn sync_menu(state: State<'_, MenuState>, items: Vec<MenuItemSync>) {
    let menu = state.0.lock().expect("menu lock poisoned");
    for sync in items {
        if let Some(item) = menu.get(&sync.id) {
            let _ = item.set_accelerator(usable_accelerator(sync.accelerator.as_deref()));
            let _ = item.set_enabled(sync.enabled);
        }
    }
}

/// Builds the menu bar and makes it the app's menu.
#[cfg(target_os = "macos")]
pub(crate) fn install(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, Submenu};

    let menu = Menu::new(app)?;
    let mut commands = HashMap::new();
    let mut submenus = Vec::new();
    for (title, entries) in LAYOUT {
        let submenu = Submenu::new(app, *title, true)?;
        for entry in *entries {
            match entry {
                Command(id, label) => {
                    // No shortcut until the UI says which one applies.
                    let item = MenuItem::with_id(app, *id, *label, true, None::<&str>)?;
                    submenu.append(&item)?;
                    commands.insert((*id).to_owned(), item);
                }
                App(id, label, accelerator) => {
                    submenu.append(&MenuItem::with_id(app, *id, *label, true, *accelerator)?)?
                }
                Entry::Native(native) => submenu.append(&native_item(app, *native)?)?,
                Separator => submenu.append(&tauri::menu::PredefinedMenuItem::separator(app)?)?,
            }
        }
        menu.append(&submenu)?;
        submenus.push((*title, submenu));
    }
    app.set_menu(menu)?;
    for (title, submenu) in submenus {
        match title {
            // The window list goes here, and the Help menu gets the system's search field.
            "Window" => submenu.set_as_windows_menu_for_nsapp()?,
            "Help" => submenu.set_as_help_menu_for_nsapp()?,
            _ => {}
        }
    }
    *app.state::<MenuState>()
        .0
        .lock()
        .expect("menu lock poisoned") = commands;
    Ok(())
}

#[cfg(target_os = "macos")]
fn native_item(
    app: &AppHandle,
    native: Native,
) -> tauri::Result<tauri::menu::PredefinedMenuItem<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, PredefinedMenuItem as P};

    let name = app.package_info().name.clone();
    Ok(match native {
        Native::About => P::about(
            app,
            Some(&format!("About {name}")),
            Some(AboutMetadata {
                name: Some(name.clone()),
                version: Some(app.package_info().version.to_string()),
                copyright: app.config().bundle.copyright.clone(),
                ..Default::default()
            }),
        )?,
        Native::Services => P::services(app, None)?,
        Native::Hide => P::hide(app, Some(&format!("Hide {name}")))?,
        Native::HideOthers => P::hide_others(app, None)?,
        Native::ShowAll => P::show_all(app, None)?,
        Native::Quit => P::quit(app, Some(&format!("Quit {name}")))?,
        Native::Undo => P::undo(app, None)?,
        Native::Redo => P::redo(app, None)?,
        Native::Cut => P::cut(app, None)?,
        Native::Copy => P::copy(app, None)?,
        Native::Paste => P::paste(app, None)?,
        Native::SelectAll => P::select_all(app, None)?,
        Native::Fullscreen => P::fullscreen(app, Some("Enter Full Screen"))?,
        Native::Minimize => P::minimize(app, None)?,
        Native::Zoom => P::maximize(app, Some("Zoom"))?,
        Native::BringAllToFront => P::bring_all_to_front(app, None)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::str::FromStr;

    fn ids() -> Vec<&'static str> {
        LAYOUT
            .iter()
            .flat_map(|(_, entries)| entries.iter())
            .filter_map(|entry| match entry {
                Command(id, _) | App(id, _, _) => Some(*id),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_menu_bar_has_the_standard_mac_menus() {
        let titles: Vec<_> = LAYOUT.iter().map(|(title, _)| *title).collect();
        assert_eq!(titles, ["Mosaic", "File", "Edit", "View", "Window", "Help"]);
    }

    #[test]
    fn every_item_has_its_own_id() {
        let ids = ids();
        let unique: HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len(), "duplicate menu ids in {ids:?}");
    }

    #[test]
    fn menus_never_start_or_end_with_a_separator_or_double_one() {
        for (title, entries) in LAYOUT {
            assert_ne!(entries.first(), Some(&Separator), "{title}");
            assert_ne!(entries.last(), Some(&Separator), "{title}");
            assert!(
                entries
                    .windows(2)
                    .all(|w| !(w[0] == Separator && w[1] == Separator)),
                "{title} has two separators in a row"
            );
        }
    }

    #[test]
    fn standard_text_editing_stays_native() {
        let edit = LAYOUT.iter().find(|(t, _)| *t == "Edit").unwrap().1;
        for native in [
            Native::Undo,
            Native::Redo,
            Native::Cut,
            Native::Copy,
            Native::Paste,
            Native::SelectAll,
        ] {
            assert!(edit.contains(&Entry::Native(native)), "{native:?}");
        }
    }

    #[test]
    fn chosen_items_map_to_their_action() {
        assert_eq!(action("new-note"), Action::RunCommand("new-note"));
        assert_eq!(action("feedback"), Action::RunCommand("feedback"));
        assert_eq!(action(CLOSE_WINDOW), Action::CloseWindow);
        assert_eq!(action(OPEN_GITHUB), Action::OpenUrl(GITHUB_URL));
        assert_eq!(action("not-a-menu-item"), Action::Ignore);
        assert!(!command_ids().contains(&CLOSE_WINDOW));
    }

    #[test]
    fn only_command_shortcuts_reach_the_menu() {
        assert_eq!(
            usable_accelerator(Some("Cmd+Shift+KeyN")),
            Some("Cmd+Shift+KeyN")
        );
        assert_eq!(
            usable_accelerator(Some("Alt+Cmd+KeyL")),
            Some("Alt+Cmd+KeyL")
        );
        assert_eq!(usable_accelerator(Some("Shift+KeyN")), None);
        assert_eq!(usable_accelerator(Some("KeyN")), None);
        assert_eq!(usable_accelerator(Some("Cmd+")), None);
        assert_eq!(usable_accelerator(None), None);
    }

    /// The UI sends `KeyboardEvent.code` names; these are the codes its default shortcuts use.
    #[test]
    fn the_shortcuts_the_ui_sends_parse() {
        for accelerator in [
            "Cmd+KeyP",
            "Cmd+Shift+KeyF",
            "Cmd+Comma",
            "Cmd+Semicolon",
            "Cmd+Backslash",
            "Cmd+Shift+Backslash",
            "Alt+Cmd+KeyL",
            "Cmd+Digit1",
            "Cmd+Digit0",
            "Cmd+Equal",
            "Cmd+Minus",
            "Cmd+BracketLeft",
            "Cmd+Enter",
            "Cmd+Backspace",
            "Cmd+Shift+KeyW",
        ] {
            assert!(
                muda::accelerator::Accelerator::from_str(accelerator).is_ok(),
                "{accelerator}"
            );
        }
    }
}
