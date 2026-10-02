//! SVG → PNG for the `render` command and MCP tool (resvg: pure Rust, offline, macOS system fonts).

use anyhow::{Context, Result};
use resvg::tiny_skia::{Pixmap, Transform};
use resvg::usvg::{self, fontdb};
use std::sync::{Arc, OnceLock};

/// Largest side of a rendered image, in pixels (keeps agent images and memory reasonable).
const MAX_SIDE: f32 = 4096.0;

/// System fonts, loaded once per process (scanning them takes a moment).
fn fonts() -> Arc<fontdb::Database> {
    static FONTS: OnceLock<Arc<fontdb::Database>> = OnceLock::new();
    FONTS
        .get_or_init(|| {
            let mut db = fontdb::Database::new();
            db.load_system_fonts();
            db.set_sans_serif_family("Helvetica");
            Arc::new(db)
        })
        .clone()
}

/// Renders SVG markup to PNG bytes at `scale` (2 = sharp on Retina screens), capped at 4096 px.
pub fn svg_to_png(svg: &str, scale: f32) -> Result<Vec<u8>> {
    let opt = usvg::Options {
        font_family: "Helvetica".into(),
        fontdb: fonts(),
        ..usvg::Options::default()
    };
    let tree = usvg::Tree::from_str(svg, &opt).context("the drawing isn't valid SVG")?;
    let size = tree.size();
    let s = scale.min(MAX_SIDE / size.width().max(size.height()));
    let (w, h) = (
        (size.width() * s).ceil() as u32,
        (size.height() * s).ceil() as u32,
    );
    let mut pixmap =
        Pixmap::new(w.max(1), h.max(1)).context("the drawing is too large to render")?;
    resvg::render(&tree, Transform::from_scale(s, s), &mut pixmap.as_mut());
    pixmap.encode_png().context("couldn't encode the PNG")
}
