import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { useWorkspace, migrateLayout } from "./workspace";
import { useUi } from "./ui";
import { useChat, chatGroup } from "./chat";
import { contextKind, viewPath } from "../views/specialTabs";
import { api } from "../ipc/api";

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string,v: string) => storage.set(k,v) });
  useWorkspace.setState({ panes: [{id:"p",tabs:[],active:null}], focused:"p", buffers:{}, direction:"row" });
  useUi.setState({destination:"notes",leftSidebar:true,rightPanel:true});
  useChat.setState({root:null,chats:{},storageError:null});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("destinations and repeated rail clicks never replace the active workspace", async () => {
  await useWorkspace.getState().open("Welcome.md");
  for (const destination of ["find","plan","ai","notes"] as const) {
    useUi.getState().selectDestination(destination);
    expect(useWorkspace.getState().activePath()).toBe("Welcome.md");
    expect(useUi.getState().leftSidebar).toBe(true);
    useUi.getState().selectDestination(destination);
    expect(useUi.getState().leftSidebar).toBe(false);
  }
});
test("mixed workspace splits and active pane restore from the original layout", async () => {
  const original = { panes: [{id:"a",tabs:["Welcome.md"],active:"Welcome.md",size:2},{id:"b",tabs:["mosaic:calendar","mosaic:settings"],active:"mosaic:settings",size:1}],focused:"b",direction:"row" };
  storage.set("mosaic:layout:example", JSON.stringify(original));
  const read = vi.spyOn(api,"read");
  await useWorkspace.getState().restoreLayout("example");
  expect(useWorkspace.getState().activePath()).toBe("mosaic:settings");
  expect(useWorkspace.getState().panes.map(p=>p.tabs)).toEqual(original.panes.map(p=>p.tabs));
  expect(read.mock.calls.every(([p])=>!p.startsWith("mosaic:"))).toBe(true);
  useWorkspace.getState().split("column");
  expect(useWorkspace.getState().panes[2].active).toBe("mosaic:settings");
  expect(JSON.parse(storage.get("mosaic:layout:example")!).version).toBe(2);
});
test("layout migration repairs malformed fields without losing valid tabs", () => {
  expect(migrateLayout({panes:[{tabs:[null,"Welcome.md","Welcome.md","mosaic:calendar"],active:"missing",size:-1}],direction:"broken"})).toMatchObject({panes:[{tabs:["Welcome.md","mosaic:calendar"],active:"Welcome.md",size:1}],direction:"row"});
  expect(migrateLayout({panes:"bad"})).toBeNull();
});
test("context changes with workspace kind and has no stale fallback", () => {
  expect(["Note.md",viewPath("chat","a"),viewPath("workflow","agent"),viewPath("run","42"),"mosaic:calendar","mosaic:settings",null].map(contextKind)).toEqual(["note","chat","workflow","run","calendar",null,null]);
});
test("chat messages, title, draft, attachments and session survive restart, isolated by vault", async () => {
  vi.spyOn(api,"chatSend").mockResolvedValue(42);
  const chat=useChat.getState;
  chat().restore("A"); const id=chat().create(["Welcome.md"]);
  await chat().send(id,"Plan my weekly review",["Welcome.md"],"Welcome.md",null,null,"sonnet");
  chat().apply(42,{kind:"done",session_id:"session-a",cost_usd:0.2,error:null});
  chat().update(id,{draft:"Follow up",model:"sonnet"});
  chat().restore("B"); expect(Object.keys(chat().chats)).toHaveLength(0);
  chat().restore("A"); expect(chat().chats[id]).toMatchObject({title:"Plan my weekly review",draft:"Follow up",attached:["Welcome.md"],session:"session-a",cost:0.2,model:"sonnet",run:null});
});
test("concurrent answers route to their original chats and interrupted chats can resume", async () => {
  vi.spyOn(api,"chatSend").mockResolvedValueOnce(1).mockResolvedValueOnce(2);
  vi.spyOn(api,"chatStop").mockResolvedValue(undefined);
  const chat=useChat.getState; chat().restore("A"); const a=chat().create(); const b=chat().create();
  await chat().send(a,"First",[],null,null,null,null); await chat().send(b,"Second",[],null,null,null,null);
  chat().apply(1,{kind:"text",text:"Answer one"}); chat().apply(2,{kind:"text",text:"Answer two"});
  expect(chat().chats[a].items.at(-1)).toEqual({kind:"text",text:"Answer one"});
  expect(chat().chats[b].items.at(-1)).toEqual({kind:"text",text:"Answer two"});
  chat().restore("A"); expect(chat().chats[a].run).toBeNull(); expect(chat().chats[a].items.at(-1)?.kind).toBe("error");
});
test("chat groups use local calendar days", () => {
  const now=new Date(2026,9,7,14); expect(chatGroup(+new Date(2026,9,7,1),now)).toBe("Today"); expect(chatGroup(+new Date(2026,8,30,1),now)).toBe("Previous 7 days"); expect(chatGroup(+new Date(2026,8,29,23),now)).toBe("Older");
});
