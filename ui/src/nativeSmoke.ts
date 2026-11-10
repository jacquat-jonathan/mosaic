// This module is reachable only in an explicit VITE_NATIVE_SMOKE production test build.
import { invoke } from "@tauri-apps/api/core";
import { api, fileUrl, inTauri, onVaultChanged } from "./ipc/api";
import { useVault } from "./state/vault";
import { useWorkspace } from "./state/workspace";
import { collectViewerDiagnostics } from "./nativeSmokeDiagnostics";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export async function runNativeSmoke() {
  const checks: string[] = [];
  const runtimeErrors: string[] = [];
  const captureError = (event: ErrorEvent) => runtimeErrors.push(event.message);
  const captureRejection = (event: PromiseRejectionEvent) => runtimeErrors.push(String(event.reason));
  window.addEventListener("error", captureError);
  window.addEventListener("unhandledrejection", captureRejection);
  const mark = async (label: string) => {
    checks.push(label);
    await invoke("smoke_report", { report: { pending: true, checks } });
  };
  let unlisten: (() => void) | undefined;
  try {
    await mark("frontend started");
    assert(inTauri, "smoke must run in a real Tauri webview");
    const context = await invoke<{ vault: string; phase: string }>("smoke_context");
    // App boot already restores the last vault on restart. Reopening it would race a second
    // index/watcher lifecycle and would not test the actual restoration path.
    if (useVault.getState().vault?.root !== context.vault) {
      await useVault.getState().openVault(context.vault);
    }
    assert(useVault.getState().vault?.root === context.vault, "native vault activation failed");
    await mark("real IPC open vault");
    if (context.phase === "restart") {
      assert((await api.read("Smoke.md")).content === "# External MCP edit\n", "restart lost external content");
      assert(
        (await api.plannerTasks()).some((task) => task.title === "Native smoke task"),
        "restart lost planner task",
      );
      await mark("restart preserved notes and planner");
    } else {
      await api.create("Smoke.md", "# Initial\n");
      await useWorkspace.getState().open("Smoke.md");
      useWorkspace.getState().edit("Smoke.md", "# Native editor save\n");
      await useWorkspace.getState().save("Smoke.md");
      const before = await api.read("Smoke.md");
      assert(before.content === "# Native editor save\n", "editor save failed");
      await mark("editor store save through native IPC");
      let changed = false;
      unlisten = await onVaultChanged((event) => {
        if (event.paths.includes("External-marker.md")) changed = true;
      });
      await invoke("smoke_external");
      const deadline = Date.now() + 15000;
      while (!changed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      assert(changed, "external MCP edit did not emit native watcher event");
      assert((await api.read("Smoke.md")).content === "# External MCP edit\n", "MCP write not visible through IPC");
      let conflict = false;
      try {
        await api.write("Smoke.md", "stale overwrite", before.hash);
      } catch (error) {
        conflict = (error as { code?: string }).code === "conflict";
      }
      assert(conflict, "stale write was not rejected with conflict code");
      await mark("bundled MCP handshake, watcher, and stale-write conflict");
      await api.createPlannerTask({ title: "Native smoke task", description: "Fixture only", status: "new" });
      await mark("native planner mutation");
    }
    await mark("opening packaged image viewer");
    await useWorkspace.getState().open("pixel.png");
    const imageDeadline = Date.now() + 15000;
    let image: HTMLImageElement | null = null;
    while (Date.now() < imageDeadline) {
      image = document.querySelector<HTMLImageElement>('.image-viewer img[alt="pixel.png"]');
      if (image?.complete && image.naturalWidth === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(image?.complete && image.naturalWidth === 1, "packaged image viewer did not decode the native asset");
    await mark("packaged image decoded; fetching PDF range");
    const pdf = await fetch(await fileUrl("fixture.pdf"), { headers: { Range: "bytes=0-7" } });
    const pdfPrefix = await pdf.text();
    assert(
      pdf.status === 206 && pdfPrefix.length === 8 && pdfPrefix.startsWith("%PDF-"),
      "PDF asset did not honor the requested byte range",
    );
    await mark("PDF byte range verified; opening packaged PDF viewer");
    await useWorkspace.getState().open("fixture.pdf");
    const pdfDeadline = Date.now() + 15000;
    while (
      !document.querySelector(".pdf-viewer .pdf-page:not([aria-busy=true]) canvas:not([hidden])") &&
      Date.now() < pdfDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const canvas = document.querySelector<HTMLCanvasElement>(
      ".pdf-viewer .pdf-page:not([aria-busy=true]) canvas:not([hidden])",
    );
    assert(canvas && canvas.width > 0, "packaged PDF viewer failed to render");
    await mark("WKWebView image decode, PDF asset fetch and packaged PDF viewer");
    await useWorkspace.getState().open("Smoke.md");
    await useWorkspace.getState().reload("Smoke.md");
    await invoke("smoke_report", {
      report: { ok: true, checks, phase: context.phase, userAgent: navigator.userAgent },
    });
  } catch (error) {
    await invoke("smoke_report", {
      report: {
        ok: false,
        checks,
        error: String(error),
        detail: {
          viewer: collectViewerDiagnostics(),
          activePath: useWorkspace.getState().activePath(),
          runtimeErrors: runtimeErrors.slice(-10),
          userAgent: navigator.userAgent,
        },
      },
    });
  } finally {
    unlisten?.();
    window.removeEventListener("error", captureError);
    window.removeEventListener("unhandledrejection", captureRejection);
  }
}
