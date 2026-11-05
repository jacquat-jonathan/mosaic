// Types the backend sends and accepts come from ./bindings.ts (generated from Rust); the names
// the UI used before stay as aliases. Event payloads below are not commands and stay hand-written.
import type * as B from "./bindings";

export type FileKind = B.FileKind;
export type Entry = B.Entry;
export type FileContent = B.FileContent_Serialize;
export type Written = B.Written_Serialize;
export type VaultInfo = B.VaultInfo_Serialize;
export type RecentVault = B.RecentVault;
export type CoreError = B.Error;
export type SearchHit = B.SearchHit;
export type TaskRow = B.TaskRow;
export type ClaudeInfo = B.ClaudeInfo;
export type Agent = B.Agent;
export type AgentRun = B.AgentRun;
export type TesseraStatus = B.TesseraStatus;
export type DayTask = B.DayTask;
export type Day = B.Day;
export type Days = B.Days;
export type CarryOver = B.CarryOver;
export type PlannerTaskStatus = B.TaskStatus;
export type PlannerSummary = B.PlannerSummary;
export type PlannerActivityEntry = B.ActivityEntry;
export type PlannerEpic = B.Epic;
export type PlannerTask = B.PlannerTask;
export type CreatePlannerEpic = B.CreateEpic;
export type UpdatePlannerEpic = B.UpdateEpic;
export type CreatePlannerTask = B.CreateTask;
export type UpdatePlannerTask = B.UpdateTask;
export type MovePlannerTask = B.MoveTask;
export type PlannerWorkSession = B.WorkSession;
export type CreatePlannerWorkSession = B.CreateWorkSession;
export type UpdatePlannerWorkSession = B.UpdateWorkSession;
export type PlannerEvent = B.PlannerEvent;
export type CreatePlannerEvent = B.CreateEvent;
export type UpdatePlannerEvent = B.UpdateEvent;
export type EventOccurrence = B.EventOccurrence;
export type CalendarWorkSession = B.CalendarWorkSession;
export type DueMarker = B.DueMarker;
export type DayWorkload = B.DayWorkload;
export type PlannerCalendarRange = B.CalendarRange;
export type IcalImportCandidate = B.IcalImportCandidate;
export type IcalImportPreview = B.IcalImportPreview;
export type IcalImportResult = B.IcalImportResult;
export type CalendarSubscription = B.SubscriptionView;
export type CalendarOverlayOccurrence = B.OverlayOccurrence;
export type CalendarOverlayRange = B.OverlayRange;
export type QueryRow = B.QueryRow_Serialize;
export type QueryResult = B.QueryResult_Serialize;
export type Backlink = B.Backlink;
export type TagCount = B.TagCount;
export type Renamed = B.Renamed_Serialize;
export type UnfinishedRename = B.UnfinishedRename;
export type CliInfo = B.CliInfo;
export type UpdateStatus = B.UpdateStatus;
export type Release = B.Release;
export type UpdateCheck = B.UpdateCheck;
export type Mention = B.Mention;
export type AgentRule = B.AgentRule;
export type Proposal = B.Proposal;
export type Version = B.Version;
export type TemplateRule = B.TemplateRule;
export type TemplateConfig = B.TemplateConfig;
export type TemplateList = B.TemplateList;
export type TemplateRequest = B.TemplateRequest;
export type TemplatePreview = B.TemplatePreview;

// Mirrors of the serialized mosaic-core types.

export function isCoreError(e: unknown): e is CoreError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

export function errorMessage(e: unknown): string {
  if (isCoreError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** What a chat answer is made of, as it streams in (crates/mosaic-core/src/chat.rs). */
export type ChatEvent = B.ChatEvent;

export interface PlannerChanged {
  root: string;
  revision: number;
  affected_ids: string[];
}

export interface IndexProgress {
  done: number;
  total: number;
  finished: boolean;
}

export interface UpdateDone {
  ok: boolean;
  cancelled: boolean;
  error: string | null;
}
