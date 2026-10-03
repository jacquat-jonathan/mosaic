// Tabs that show a view of the vault rather than one of its files. Their "path" can't be a vault
// path (it has a colon), so it never clashes with a file.

export const CALENDAR_TAB = "mosaic:calendar";

export const isSpecialTab = (path: string) => path.startsWith("mosaic:");

export const specialTabName = (path: string) => (path === CALENDAR_TAB ? "Calendar" : path.slice("mosaic:".length));
