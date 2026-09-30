//! Mosaic core: the only code that touches a vault. The app, CLI and MCP server are thin front ends over it.

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
