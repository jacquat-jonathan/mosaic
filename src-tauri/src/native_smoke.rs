//! Deliberately feature-gated harness, absent from shipping artifacts. No arbitrary file/command API.
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub fn validate_environment() -> Result<PathBuf, String> {
    let root = PathBuf::from(std::env::var("MOSAIC_SMOKE_ROOT").map_err(|e| e.to_string())?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !root.join(".native-smoke-fixture").is_file()
        || !root.starts_with(
            std::env::temp_dir()
                .canonicalize()
                .map_err(|e| e.to_string())?,
        )
    {
        return Err("smoke root must be a marked temporary fixture".into());
    }
    for key in ["MOSAIC_SETTINGS_DIR", "MOSAIC_CACHE_DIR"] {
        let path = PathBuf::from(std::env::var(key).map_err(|e| e.to_string())?)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !path.starts_with(&root) || path == root {
            return Err(format!("{key} must be inside fixture"));
        }
    }
    Ok(root)
}

#[tauri::command(async)]
pub fn smoke_context() -> Result<Value, String> {
    let root = validate_environment()?;
    Ok(
        json!({"vault": root.join("Vault"), "phase": std::env::var("MOSAIC_SMOKE_PHASE").unwrap_or_else(|_| "first".into())}),
    )
}

/// Talks to the bundled sidecar as an external MCP client, through real JSON-RPC stdio.
#[tauri::command(async)]
pub fn smoke_external() -> Result<Value, String> {
    let root = validate_environment()?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let cli = exe
        .parent()
        .ok_or("bundle executable directory missing")?
        .join("mosaic");
    let mut child = Command::new(cli)
        .args(["--vault"])
        .arg(root.join("Vault"))
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let mut input = child.stdin.take().ok_or("MCP stdin missing")?;
        let mut output = BufReader::new(child.stdout.take().ok_or("MCP stdout missing")?);
        let mut request = |id: u32, method: &str, params: Value| -> Result<Value, String> {
            writeln!(
                input,
                "{}",
                json!({"jsonrpc":"2.0", "id":id, "method":method,"params":params})
            )
            .map_err(|e| e.to_string())?;
            input.flush().map_err(|e| e.to_string())?;
            loop {
                let mut line = String::new();
                if output.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                    return Err("MCP closed stdout".into());
                }
                let response: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
                if response["id"] == id {
                    return Ok(response);
                }
            }
        };
        let init = request(
            1,
            "initialize",
            json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"native-smoke","version":"1"}}),
        )?;
        if init["result"]["serverInfo"]["name"] != "mosaic" {
            return Err(format!("bad MCP handshake: {init}"));
        }
        let edit = request(
            2,
            "tools/call",
            json!({"name":"edit_file","arguments":{"path":"Smoke.md","content":"# External MCP edit\n"}}),
        )?;
        if edit.get("error").is_some() || edit["result"]["isError"] == true {
            return Err(format!("MCP edit failed: {edit}"));
        }
        // A dedicated path cannot be confused with the desktop's earlier save notification.
        let marker = request(
            3,
            "tools/call",
            json!({"name":"create_file","arguments":{"path":"External-marker.md","content":"external watcher fixture"}}),
        )?;
        if marker.get("error").is_some() || marker["result"]["isError"] == true {
            return Err(format!("MCP marker failed: {marker}"));
        }
        Ok(json!({"handshake":init,"edit":edit,"marker":marker}))
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

#[tauri::command(async)]
pub fn smoke_report(report: Value) -> Result<(), String> {
    let root = validate_environment()?;
    let phase = std::env::var("MOSAIC_SMOKE_PHASE").unwrap_or_else(|_| "first".into());
    if !["first", "restart"].contains(&phase.as_str()) {
        return Err("unknown phase".into());
    }
    std::fs::write(
        root.join(format!("{phase}.json")),
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
