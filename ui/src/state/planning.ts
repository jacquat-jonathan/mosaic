import { create } from "zustand";
import { useUi } from "./ui";
import { dayStamp } from "../daily";
export interface PlanningView { id: string; title: string; query: string }
interface Planning { root: string | null; views: PlanningView[]; selectedDay: string; restore(root: string): void; create(): Promise<void> }
export const usePlanning = create<Planning>((set, get) => ({
  root: null, views: [], selectedDay: dayStamp(),
  restore(root) { let views: PlanningView[] = []; try { const v = JSON.parse(localStorage.getItem(`mosaic:planning:${root}`) ?? "[]"); if (Array.isArray(v)) views = v.filter(x => typeof x.id === "string" && typeof x.title === "string" && typeof x.query === "string"); } catch { /* Empty on invalid storage. */ } set({ root, views, selectedDay: dayStamp() }); },
  async create() {
    const root = get().root;
    const title = await useUi.getState().askText({ title: "Planning view name", value: "", placeholder: "My project" }); if (!title?.trim()) return;
    const query = await useUi.getState().askText({ title: "Task query", value: "task:open", placeholder: "task:open tag:project" }); if (!query?.trim() || root !== get().root) return;
    const id = crypto.randomUUID(); const views = [...get().views, { id, title: title.trim(), query: query.trim() }];
    try { localStorage.setItem(`mosaic:planning:${root}`, JSON.stringify(views)); set({ views }); useUi.getState().openView("planning", id); } catch { /* Keep the view usable for this session. */ set({ views }); }
  },
}));
