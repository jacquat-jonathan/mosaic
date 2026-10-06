//! Window geometry is app state, independent of the vault and portable note content.
use serde::{Deserialize, Serialize};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow, Window};

#[derive(Default, Serialize, Deserialize)]
struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
    fullscreen: bool,
}

fn path() -> Option<std::path::PathBuf> {
    mosaic_core::settings::app_support_dir().map(|p| p.join("window.json"))
}

pub fn restore(window: &WebviewWindow) {
    let Some(path) = path() else {
        return;
    };
    let Some(saved) = std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Geometry>(&b).ok())
    else {
        // Keep normal bounds even when the first interaction is entering fullscreen.
        save(&window.as_ref().window());
        return;
    };
    let monitors = window.available_monitors().unwrap_or_default();
    // A removed monitor must never leave the restored window off screen.
    if let Some(monitor) = monitors
        .iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();
            saved.x >= p.x
                && saved.y >= p.y
                && saved.x < p.x + s.width as i32
                && saved.y < p.y + s.height as i32
        })
        .or(monitors.first())
    {
        let p = monitor.position();
        let s = monitor.size();
        let scale = monitor.scale_factor();
        let width = saved.width.max((720.0 * scale) as u32).min(s.width);
        let height = saved.height.max((480.0 * scale) as u32).min(s.height);
        let x = saved.x.max(p.x).min(p.x + (s.width - width) as i32);
        let y = saved.y.max(p.y).min(p.y + (s.height - height) as i32);
        let _ = window.set_size(PhysicalSize::new(width, height));
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    if saved.maximized {
        let _ = window.maximize();
    }
    if saved.fullscreen {
        let _ = window.set_fullscreen(true);
    }
}

pub fn save(window: &Window) {
    let Some(path) = path() else {
        return;
    };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let maximized = window.is_maximized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    let mut saved = Geometry {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized,
        fullscreen,
    };
    if maximized || fullscreen {
        if let Some(previous) = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Geometry>(&b).ok())
        {
            saved = Geometry {
                maximized,
                fullscreen,
                ..previous
            };
        }
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(bytes) = serde_json::to_vec(&saved) {
        let temp = path.with_extension("json.tmp");
        if std::fs::write(&temp, bytes).is_ok() {
            let _ = std::fs::rename(temp, path);
        }
    }
}
