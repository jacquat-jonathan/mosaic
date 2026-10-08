//! Shared note templates, independent of the UI and ordinary raw-file creation.
use crate::vault::normalize;
use crate::{Error, Result, Workspace, Written};
use chrono::{DateTime, FixedOffset, Local};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TemplateRule {
    pub folder: String,
    /// None explicitly stops inheritance with a blank note.
    pub template: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TemplateConfig {
    pub version: u32,
    pub folder: String,
    pub rules: Vec<TemplateRule>,
}
impl Default for TemplateConfig {
    fn default() -> Self {
        Self {
            version: 1,
            folder: "Templates".into(),
            rules: vec![],
        }
    }
}
pub fn within(path: &str, folder: &str) -> bool {
    let p = path.to_lowercase();
    let f = folder.to_lowercase();
    f.is_empty() || p == f || p.starts_with(&format!("{f}/"))
}
impl TemplateConfig {
    pub fn validate(&self) -> Result<()> {
        if self.version != 1 {
            return Err(Error::Invalid(
                "Unsupported template settings version; repair in Settings › Templates".into(),
            ));
        }
        if self.folder.is_empty() || normalize(&self.folder)? != self.folder {
            return Err(Error::InvalidPath(
                "Choose a non-root Templates folder".into(),
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for rule in &self.rules {
            if normalize(&rule.folder)? != rule.folder || !seen.insert(rule.folder.to_lowercase()) {
                return Err(Error::Invalid(
                    "Each folder needs one valid template rule".into(),
                ));
            }
            if let Some(t) = &rule.template
                && (normalize(t)? != *t
                    || !within(t, &self.folder)
                    || !t.to_lowercase().ends_with(".md"))
            {
                return Err(Error::Invalid(
                    "Defaults must reference Markdown files inside the Templates folder".into(),
                ));
            }
        }
        Ok(())
    }
    pub fn resolve(&self, path: &str) -> TemplateResolution {
        let parent = path.rsplit_once('/').map_or("", |(p, _)| p);
        if within(path, &self.folder) {
            return TemplateResolution::default();
        }
        let rule = self
            .rules
            .iter()
            .filter(|r| within(parent, &r.folder))
            .max_by_key(|r| r.folder.len());
        TemplateResolution {
            template: rule.and_then(|r| r.template.clone()),
            rule_folder: rule.map(|r| r.folder.clone()),
        }
    }
    pub fn remap(&mut self, from: &str, to: &str) {
        let map = |p: &mut String| {
            if p == from {
                *p = to.into();
            } else if let Some(rest) = p.strip_prefix(&format!("{from}/")) {
                *p = format!("{to}/{rest}");
            }
        };
        map(&mut self.folder);
        for r in &mut self.rules {
            map(&mut r.folder);
            if let Some(t) = &mut r.template {
                map(t);
            }
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TemplateResolution {
    pub template: Option<String>,
    pub rule_folder: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct TemplateEntry {
    pub path: String,
    pub name: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct TemplateList {
    pub templates: Vec<TemplateEntry>,
    pub default: TemplateResolution,
}
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct TemplateRequest {
    pub path: String,
    #[serde(default)]
    pub template: Option<String>,
    #[serde(default)]
    pub blank: bool,
    /// RFC3339 with the caller's timezone offset; shared between preview and creation.
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub expected_template_hash: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct TemplateContext {
    pub title: String,
    pub date: String,
    pub time: String,
    pub weekday: String,
    pub timestamp: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct TemplatePreview {
    pub path: String,
    pub content: String,
    pub template: Option<String>,
    pub template_hash: Option<String>,
    pub rule_folder: Option<String>,
    pub context: TemplateContext,
}
#[derive(Debug, Clone, Serialize)]
pub struct CreatedNote {
    #[serde(flatten)]
    pub written: Written,
    pub template: Option<String>,
    pub rule_folder: Option<String>,
}

pub fn note_path(path: &str) -> Result<String> {
    let p = normalize(path)?;
    if !p.to_lowercase().ends_with(".md") || p.rsplit('/').next().is_none_or(|s| s.len() <= 3) {
        return Err(Error::InvalidPath(
            "A note needs a name and .md extension".into(),
        ));
    }
    Ok(p)
}
pub fn context(path: &str, timestamp: Option<&str>) -> Result<TemplateContext> {
    let d: DateTime<FixedOffset> = match timestamp {
        Some(t) => DateTime::parse_from_rfc3339(t).map_err(|_| {
            Error::Invalid("Template timestamp must be RFC3339 with a timezone offset".into())
        })?,
        None => Local::now().fixed_offset(),
    };
    let name = path.rsplit('/').next().unwrap_or(path);
    Ok(TemplateContext {
        title: name[..name.len() - 3].into(),
        date: d.format("%Y-%m-%d").to_string(),
        time: d.format("%H:%M").to_string(),
        weekday: d.format("%A").to_string(),
        timestamp: d.to_rfc3339(),
    })
}
pub fn fill(source: &str, c: &TemplateContext) -> String {
    regex::Regex::new(r"\{\{\s*(title|date|time|weekday)\s*\}\}")
        .expect("template regex")
        .replace_all(source, |m: &regex::Captures| match &m[1] {
            "title" => c.title.clone(),
            "date" => c.date.clone(),
            "time" => c.time.clone(),
            _ => c.weekday.clone(),
        })
        .into_owned()
}
pub fn render(
    ws: &Workspace,
    config: &TemplateConfig,
    req: &TemplateRequest,
) -> Result<TemplatePreview> {
    config.validate()?;
    let path = note_path(&req.path)?;
    if req.blank && req.template.is_some() {
        return Err(Error::Invalid("Choose either a template or Blank".into()));
    }
    let resolved = if req.blank {
        TemplateResolution::default()
    } else if let Some(t) = &req.template {
        TemplateResolution {
            template: Some(normalize(t)?),
            rule_folder: None,
        }
    } else {
        config.resolve(&path)
    };
    let c = context(&path, req.timestamp.as_deref())?;
    let (content, hash) = if let Some(t) = &resolved.template {
        if !within(t, &config.folder) || !t.to_lowercase().ends_with(".md") {
            return Err(Error::Invalid(
                "Choose a Markdown template inside the configured Templates folder".into(),
            ));
        }
        let file = ws.read(t)?;
        if let Some(expected) = &req.expected_template_hash
            && &file.hash != expected
        {
            return Err(Error::Conflict {
                path: t.clone(),
                current_hash: file.hash.clone(),
            });
        }
        (
            fill(&file.content.ok_or_else(|| Error::NotText(t.clone()))?, &c),
            Some(file.hash),
        )
    } else {
        if req.expected_template_hash.is_some() {
            return Err(Error::Invalid(
                "The template default changed; refresh the preview".into(),
            ));
        }
        (String::new(), None)
    };
    Ok(TemplatePreview {
        path,
        content,
        template: resolved.template,
        template_hash: hash,
        rule_folder: resolved.rule_folder,
        context: c,
    })
}

pub const STARTERS: &[(&str, &str)] = &[
    (
        "Meeting.md",
        "# {{title}}\n\nDate: {{date}}\n\n## Participants\n\n## Purpose\n\n## Agenda\n\n## Notes\n\n## Decisions\n\n## Actions\n\n- [ ] \n",
    ),
    (
        "Retro.md",
        "# {{title}}\n\nDate: {{date}}\n\n## Context\n\n## What went well\n\n## What to improve\n\n## Themes\n\n## Agreed actions\n\n- [ ] \n",
    ),
    (
        "Project.md",
        "# {{title}}\n\n## Purpose\n\n## Outcomes\n\n## Scope\n\n## Stakeholders\n\n## Milestones\n\n## Decisions\n\n## Risks\n\n## Next actions\n\n- [ ] \n",
    ),
    (
        "Analysis.md",
        "# {{title}}\n\nDate: {{date}}\n\n## Question\n\n## Context\n\n## Evidence\n\n## Assumptions\n\n## Options\n\n## Recommendation\n\n## Open questions\n",
    ),
    (
        "Brainstorm.md",
        "# {{title}}\n\n## Prompt\n\n## Constraints\n\n## Ideas\n\n## Themes\n\n## Promising directions\n\n## Next experiments\n",
    ),
];

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rendering_rejects_changed_missing_and_inaccessible_sources() {
        use crate::{
            history::Source,
            index::Index,
            settings::{Access, AgentRule},
            vault::Vault,
        };
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(
            Vault::open(dir.path()).unwrap(),
            Index::in_memory().unwrap(),
        );
        ws.create(
            "Templates/Retro.md",
            "# {{title}}\nDate: {{date}}\n{{unknown}}\n",
        )
        .unwrap();
        let config = TemplateConfig {
            rules: vec![TemplateRule {
                folder: "Meetings".into(),
                template: Some("Templates/Retro.md".into()),
            }],
            ..Default::default()
        };
        let mut request = TemplateRequest {
            path: "Meetings/Sprint 5.md".into(),
            timestamp: Some("2026-10-08T23:00:00+02:00".into()),
            ..Default::default()
        };
        let preview = render(&ws, &config, &request).unwrap();
        assert_eq!(
            preview.content,
            "# Sprint 5\nDate: 2026-10-08\n{{unknown}}\n"
        );
        request.expected_template_hash = preview.template_hash;
        ws.write("Templates/Retro.md", "new source", None).unwrap();
        assert!(matches!(
            render(&ws, &config, &request),
            Err(Error::Conflict { .. })
        ));
        assert!(ws.read("Meetings/Sprint 5.md").is_err());
        request.expected_template_hash = None;
        request.blank = true;
        assert_eq!(render(&ws, &config, &request).unwrap().content, "");
        request.blank = false;
        request.template = Some("Templates/Missing.md".into());
        assert!(matches!(
            render(&ws, &config, &request),
            Err(Error::NotFound(_))
        ));
        request.template = Some("Elsewhere.md".into());
        assert!(render(&ws, &config, &request).is_err());
        request.template = None;
        let agent = ws
            .with_source(Source::Agent)
            .with_agent_rules(vec![AgentRule {
                path: "Templates".into(),
                access: Access::Hidden,
                written_as: None,
            }]);
        assert!(matches!(
            render(&agent, &config, &request),
            Err(Error::NotFound(_))
        ));
        assert!(agent.set_template_config(config).is_err());
    }
    #[test]
    fn inheritance_boundaries_blank_and_template_authoring() {
        let c = TemplateConfig {
            rules: vec![
                TemplateRule {
                    folder: "".into(),
                    template: Some("Templates/Project.md".into()),
                },
                TemplateRule {
                    folder: "Meetings".into(),
                    template: Some("Templates/Meeting.md".into()),
                },
                TemplateRule {
                    folder: "Meetings/Private".into(),
                    template: None,
                },
            ],
            ..Default::default()
        };
        c.validate().unwrap();
        assert_eq!(
            c.resolve("Meetings/Retros/A.md").template.as_deref(),
            Some("Templates/Meeting.md")
        );
        assert_eq!(
            c.resolve("MeetingsExtra/A.md").template.as_deref(),
            Some("Templates/Project.md")
        );
        assert!(c.resolve("Meetings/Private/A.md").template.is_none());
        assert!(c.resolve("Templates/A.md").template.is_none());
        assert_eq!(
            c.resolve("meetings/A.md").rule_folder.as_deref(),
            Some("Meetings")
        );
    }
    #[test]
    fn rendering_and_renames_preserve_unknown_placeholders() {
        let c = context("Meetings/Retro.md", Some("2026-10-08T23:59:00+02:00")).unwrap();
        assert_eq!(
            fill("# {{ title }} {{date}} {{time}} {{weekday}} {{other}}", &c),
            "# Retro 2026-10-08 23:59 Thursday {{other}}"
        );
        let mut config = TemplateConfig {
            rules: vec![TemplateRule {
                folder: "Meetings".into(),
                template: Some("Templates/Meeting.md".into()),
            }],
            ..Default::default()
        };
        config.remap("Templates", "Formats");
        config.remap("Meetings", "Work/Meetings");
        assert_eq!(config.folder, "Formats");
        assert_eq!(
            config.rules[0].template.as_deref(),
            Some("Formats/Meeting.md")
        );
        assert_eq!(config.rules[0].folder, "Work/Meetings");
        config.validate().unwrap();
        config.version = 99;
        assert!(config.validate().is_err());
    }
}
