//! Vault-scoped configuration shared by every front end. Never moves user content.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct VaultPreferences {
    pub version: u32,
    pub agents_folder: String,
    pub daily_folder: String,
    pub daily_template: String,
    pub daily_format: String,
    pub new_note_location: String,
    pub new_note_folder: String,
    pub attachment_location: String,
    pub attachment_folder: String,
    pub link_style: String,
    pub startup_note: String,
    pub folder_colors: BTreeMap<String, String>,
    #[serde(flatten)]
    pub other: BTreeMap<String, serde_json::Value>,
}
impl Default for VaultPreferences {
    fn default() -> Self {
        Self {
            version: 1,
            agents_folder: "Agents".into(),
            daily_folder: "Daily".into(),
            daily_template: String::new(),
            daily_format: "YYYY-MM-DD".into(),
            new_note_location: "current".into(),
            new_note_folder: String::new(),
            attachment_location: "next-to-note".into(),
            attachment_folder: String::new(),
            link_style: "wiki".into(),
            startup_note: String::new(),
            folder_colors: BTreeMap::new(),
            other: BTreeMap::new(),
        }
    }
}
impl VaultPreferences {
    pub fn patched(
        raw: Option<&serde_json::Value>,
        patch: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<serde_json::Value> {
        let mut value = raw
            .cloned()
            .unwrap_or(serde_json::to_value(Self::default()).expect("preferences"));
        if value
            .get("version")
            .and_then(|v| v.as_u64())
            .is_some_and(|v| v != 1)
        {
            return Err(Error::Invalid(
                "A newer Mosaic version wrote these preferences; upgrade before changing them"
                    .into(),
            ));
        }
        value
            .as_object_mut()
            .ok_or_else(|| {
                Error::Invalid(
                    "Vault preferences must be an object; repair settings.json before saving"
                        .into(),
                )
            })?
            .extend(patch.clone());
        serde_json::from_value::<Self>(value.clone())
            .map_err(|e| Error::Invalid(e.to_string()))?
            .validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<()> {
        if self.version != 1 {
            return Err(Error::Invalid(
                "These vault preferences need a newer Mosaic version".into(),
            ));
        }
        for path in [
            &self.agents_folder,
            &self.daily_folder,
            &self.daily_template,
            &self.new_note_folder,
            &self.attachment_folder,
            &self.startup_note,
        ]
        .into_iter()
        .chain(self.folder_colors.keys())
        {
            if !path.is_empty() && crate::vault::normalize(path)? != *path {
                return Err(Error::Invalid(format!("Use a vault-relative path: {path}")));
            }
        }
        if self.agents_folder.is_empty() {
            return Err(Error::Invalid("Agents need a dedicated folder".into()));
        }
        for (value, choices) in [
            (
                self.daily_format.as_str(),
                &["YYYY-MM-DD", "DD-MM-YYYY", "YYYYMMDD"][..],
            ),
            (
                self.new_note_location.as_str(),
                &["current", "root", "folder"][..],
            ),
            (
                self.attachment_location.as_str(),
                &["next-to-note", "folder"][..],
            ),
            (self.link_style.as_str(), &["wiki", "markdown"][..]),
        ] {
            if !choices.contains(&value) {
                return Err(Error::Invalid(format!(
                    "Unsupported vault preference: {value}"
                )));
            }
        }
        if self
            .folder_colors
            .values()
            .any(|color| !["red", "orange", "green", "blue", "purple"].contains(&color.as_str()))
        {
            return Err(Error::Invalid(
                "Choose one of the folder color presets".into(),
            ));
        }
        Ok(())
    }
    pub fn date_format(&self) -> &'static str {
        match self.daily_format.as_str() {
            "DD-MM-YYYY" => "%d-%m-%Y",
            "YYYYMMDD" => "%Y%m%d",
            _ => "%Y-%m-%d",
        }
    }
    pub fn daily_date(&self, path: &str) -> Option<chrono::NaiveDate> {
        crate::days::daily_date(path).or_else(|| {
            let stem = crate::links::file_name(path).strip_suffix(".md")?;
            let date = chrono::NaiveDate::parse_from_str(stem, self.date_format()).ok()?;
            (date.format(self.date_format()).to_string() == stem).then_some(date)
        })
    }
    pub fn remap(&mut self, from: &str, to: &str) {
        let map = |path: &str| {
            if path == from {
                to.to_string()
            } else if path.starts_with(&format!("{from}/")) {
                format!("{to}{}", &path[from.len()..])
            } else {
                path.to_string()
            }
        };
        for path in [
            &mut self.agents_folder,
            &mut self.daily_folder,
            &mut self.daily_template,
            &mut self.new_note_folder,
            &mut self.attachment_folder,
            &mut self.startup_note,
        ] {
            *path = map(path);
        }
        self.folder_colors = self
            .folder_colors
            .iter()
            .map(|(path, color)| (map(path), color.clone()))
            .collect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dates_paths_and_unknown_fields() {
        let mut p = VaultPreferences {
            daily_format: "DD-MM-YYYY".into(),
            ..Default::default()
        };
        assert!(p.daily_date("Daily/08-10-2026.md").is_some());
        assert!(p.daily_date("Daily/2026-10-08.md").is_some());
        assert!(p.daily_date("31-02-2026.md").is_none());
        p.daily_folder = "../outside".into();
        assert!(p.validate().is_err());
        let mut p: VaultPreferences =
            serde_json::from_value(serde_json::json!({"future":true})).unwrap();
        p.remap("Agents", "People");
        assert_eq!(p.agents_folder, "People");
        assert_eq!(serde_json::to_value(p).unwrap()["future"], true);
    }
}
