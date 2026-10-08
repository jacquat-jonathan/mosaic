// Non-file drafts participate in the same navigation safety as unsaved text buffers.
const guards = new Map<string, Set<() => Promise<boolean>>>();
export function registerDraft(path: string, guard: () => Promise<boolean>) {
  const group = guards.get(path) ?? new Set(); group.add(guard); guards.set(path, group);
  return () => { group.delete(guard); if (!group.size && guards.get(path) === group) guards.delete(path); };
}
export const hasDraft = (path: string) => guards.has(path);
export async function leaveDraft(path: string | null) {
  if (!path) return true;
  for (const guard of guards.get(path) ?? []) if (!(await guard())) return false;
  guards.delete(path);
  return true;
}
export async function leaveAllDrafts() {
  for (const path of [...guards.keys()]) if (!(await leaveDraft(path))) return false;
  return true;
}
