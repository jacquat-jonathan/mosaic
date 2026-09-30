use serde::Serialize;
use std::path::Path;

/// What a file is, decided by extension. Front ends pick a viewer from this; AI tools use it to know
/// how to read and write the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Markdown,
    Canvas,
    Excalidraw,
    Html,
    Image,
    Pdf,
    Csv,
    Json,
    Yaml,
    Graphviz,
    Code,
    Text,
    Other,
}

impl FileKind {
    pub fn of(path: &Path) -> Self {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if name.ends_with(".vl.json") {
            return FileKind::Json;
        }
        let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
        match ext {
            "md" | "markdown" => FileKind::Markdown,
            "canvas" => FileKind::Canvas,
            "excalidraw" => FileKind::Excalidraw,
            "html" | "htm" => FileKind::Html,
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "avif" => FileKind::Image,
            "pdf" => FileKind::Pdf,
            "csv" | "tsv" => FileKind::Csv,
            "json" => FileKind::Json,
            "yaml" | "yml" => FileKind::Yaml,
            "dot" | "gv" => FileKind::Graphviz,
            "txt" | "log" => FileKind::Text,
            "js" | "mjs" | "cjs" | "ts" | "tsx" | "jsx" | "py" | "rs" | "swift" | "kt" | "kts"
            | "java" | "go" | "rb" | "c" | "h" | "cpp" | "hpp" | "cs" | "css" | "scss" | "sh"
            | "zsh" | "bash" | "sql" | "toml" | "xml" | "php" | "lua" | "r" | "m" | "mm"
            | "gradle" | "ini" | "env" => FileKind::Code,
            _ => FileKind::Other,
        }
    }

    /// Whether the file is stored as UTF-8 text that editors (and AI edit tools) may rewrite.
    pub fn is_text(self) -> bool {
        !matches!(self, FileKind::Image | FileKind::Pdf | FileKind::Other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_by_extension() {
        assert_eq!(FileKind::of(Path::new("a/Note.MD")), FileKind::Markdown);
        assert_eq!(FileKind::of(Path::new("b.canvas")), FileKind::Canvas);
        assert_eq!(FileKind::of(Path::new("chart.vl.json")), FileKind::Json);
        assert_eq!(FileKind::of(Path::new("x.png")), FileKind::Image);
        assert_eq!(FileKind::of(Path::new("Makefile")), FileKind::Other);
        assert!(FileKind::Csv.is_text());
        assert!(!FileKind::Pdf.is_text());
    }
}
