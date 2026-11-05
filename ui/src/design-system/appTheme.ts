/** Bridge app palette variables into scoped controls, including editor-owned DOM chrome. */
export const APP_THEME_TOKENS = Object.fromEntries(
  Object.entries({
    surface: "bg",
    "surface-subtle": "bg-side",
    "surface-hover": "bg-hover",
    "surface-selected": "bg-active",
    text: "fg",
    "text-muted": "muted",
    "text-faint": "faint",
    border: "border",
    accent: "accent",
    "on-accent": "on-accent",
    danger: "danger",
    "warning-surface": "warn-bg",
    "error-surface": "err-bg",
    success: "success",
    review: "review",
    "shadow-floating": "shadow",
  }).map(([token, app]) => [`--mds-${token}`, `var(--${app})`]),
);
