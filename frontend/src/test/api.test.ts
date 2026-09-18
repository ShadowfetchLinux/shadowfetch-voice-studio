import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TtsGenerateParams } from "@/lib/protocol";

type Listener = (e: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();
const invoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: Listener) => {
    listeners.set(name, cb);
    return () => listeners.delete(name);
  }),
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const flush = () => new Promise((r) => setTimeout(r, 0));
const genParams: TtsGenerateParams = { project_id: "p1", engine_id: "qwen3-tts-base", reference_id: "r1", language: "en", settings: {} };

async function loadApi() {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
  const mod = await import("@/lib/api");
  mod.__resetForTests();
  return mod;
}

describe("api client (Tauri transport)", () => {
  beforeEach(() => {
    invoke.mockReset();
    listeners.clear();
  });

  it("generates a v4 uuid per request and sends it through worker_request", async () => {
    const { api } = await loadApi();
    invoke.mockResolvedValue({ ok: true, uptime_s: 1 });
    const p = api.system.ping();
    expect(p.id).toMatch(UUID);
    await expect(p).resolves.toEqual({ ok: true, uptime_s: 1 });
    expect(invoke).toHaveBeenCalledWith("worker_request", { id: p.id, method: "system.ping", params: {} });
    const q = api.system.ping();
    expect(q.id).not.toBe(p.id);
    await q;
  });

  it("routes progress events to the request with the matching id only", async () => {
    const { api } = await loadApi();
    invoke.mockImplementation(async (cmd, args) => {
      if (cmd !== "worker_request") return undefined;
      const emit = listeners.get("worker://progress");
      expect(emit).toBeDefined();
      emit!({ payload: { id: "someone-else", stage: "generate", message: "ignored", current: 9, total: 9 } });
      emit!({ payload: { id: args!.id, stage: "generate", message: "Generating segment 1 of 2", current: 1, total: 2 } });
      emit!({ payload: { id: args!.id, stage: "generate", message: "Generating segment 2 of 2", current: 2, total: 2 } });
      return { takes: [], skipped: [], elapsed_s: 0.1 };
    });
    const onProgress = vi.fn();
    const p = api.tts.generate(genParams, { onProgress });
    await p;
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: p.id, current: 1, total: 2 }));
    expect(onProgress).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: p.id, current: 2, total: 2 }));
    // handler is removed after completion
    listeners.get("worker://progress")!({ payload: { id: p.id, stage: "late", message: "late" } });
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("converts protocol error objects into WorkerError with code/details/recoverable", async () => {
    const { api, WorkerError } = await loadApi();
    invoke.mockRejectedValue({ code: "MODEL_MISSING", message: "Model not installed", details: { model_id: "x" }, recoverable: true });
    const err = await api.engine.load({ engine_id: "qwen3-tts-base" }).catch((e) => e);
    expect(err).toBeInstanceOf(WorkerError);
    expect(err).toMatchObject({ code: "MODEL_MISSING", message: "Model not installed", details: { model_id: "x" }, recoverable: true, method: "engine.load" });
  });

  it("wraps non-protocol failures as CLIENT errors", async () => {
    const { api } = await loadApi();
    invoke.mockRejectedValue("worker is not running");
    await expect(api.system.ping()).rejects.toMatchObject({ code: "CLIENT", message: "worker is not running" });
  });

  it("cancel(id) invokes worker_cancel and an AbortSignal cancels the in-flight request", async () => {
    const { api } = await loadApi();
    invoke.mockImplementation((cmd) => {
      if (cmd === "worker_request") return new Promise((_, rej) => setTimeout(() => rej({ code: "CANCELLED", message: "Cancelled", details: {}, recoverable: true }), 15));
      return Promise.resolve(undefined);
    });
    await api.cancel("abc");
    expect(invoke).toHaveBeenCalledWith("worker_cancel", { id: "abc" });

    const ac = new AbortController();
    const p = api.tts.generate(genParams, { signal: ac.signal });
    await flush();
    ac.abort();
    const err = await p.catch((e) => e);
    expect(err).toMatchObject({ code: "CANCELLED" });
    expect(err.cancelled).toBe(true);
    expect(invoke).toHaveBeenCalledWith("worker_cancel", { id: p.id });

    // the promise also carries a cancel() shortcut
    const q = api.tts.generate(genParams);
    await flush();
    await q.cancel();
    expect(invoke).toHaveBeenCalledWith("worker_cancel", { id: q.id });
    await q.catch(() => undefined);
  });

  it("events.on delivers worker events by name and stops after unsubscribe", async () => {
    const { api } = await loadApi();
    const cb = vi.fn();
    const off = api.events.on("record.level", cb);
    await flush();
    const emit = listeners.get("worker://event")!;
    const level = { session_id: "s", peak_dbfs: -6, rms_dbfs: -18, clipped: false, elapsed_s: 1, bytes_written: 100 };
    emit({ payload: { event: "record.level", data: level } });
    emit({ payload: { event: "engine.state", data: { engine_id: "x", state: "loaded" } } });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(level);
    off();
    emit({ payload: { event: "record.level", data: level } });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("worker status and runtime log subscriptions use their own channels", async () => {
    const { api } = await loadApi();
    const status = vi.fn();
    const log = vi.fn();
    api.events.onWorkerStatus(status);
    api.events.onRuntimeLog(log);
    await flush();
    listeners.get("worker://status")!({ payload: { running: false, restarts: 1, last_error: "boom", stopped: false } });
    listeners.get("runtime://log")!({ payload: { line: "installing torch" } });
    expect(status).toHaveBeenCalledWith({ running: false, restarts: 1, last_error: "boom", stopped: false });
    expect(log).toHaveBeenCalledWith({ line: "installing torch" });
  });

  it("shell helpers call the named Rust commands and fileSrc uses the asset protocol", async () => {
    const { api } = await loadApi();
    invoke.mockResolvedValue(["/a.wav", "/b.flac"]);
    await expect(api.shell.pickAudioFiles()).resolves.toEqual(["/a.wav", "/b.flac"]);
    expect(invoke).toHaveBeenCalledWith("pick_audio_files", {});
    invoke.mockResolvedValue(null);
    await expect(api.shell.pickSavePath("out", "wav")).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith("pick_save_path", { defaultName: "out", ext: "wav" });
    await api.system.ping().catch(() => undefined); // ensures the transport is selected
    expect(api.shell.fileSrc("/data/x.wav")).toBe("asset://localhost/%2Fdata%2Fx.wav");
  });
});
