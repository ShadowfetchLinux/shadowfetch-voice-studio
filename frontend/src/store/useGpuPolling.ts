import { useEffect } from "react";
import { useAppStore } from "./appStore";

const GPU_POLL_MS = 5000;

/**
 * Polls `system.gpu_status` every 5 s while `active` and the window has focus (engine/VRAM status in Settings and the
 * project editor). The Speak and Voices screens do not need it, so nothing is polled there.
 */
export function useGpuPolling(active: boolean) {
  const refreshGpu = useAppStore((s) => s.refreshGpu);
  const booted = useAppStore((s) => s.booted);
  useEffect(() => {
    if (!booted || !active) return;
    let timer: number | null = null;
    const tick = () => {
      if (document.hasFocus() && document.visibilityState === "visible") void refreshGpu();
    };
    const start = () => {
      if (timer == null) timer = window.setInterval(tick, GPU_POLL_MS);
      tick();
    };
    const stop = () => {
      if (timer != null) window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    window.addEventListener("focus", start);
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", onVisibility);
    if (document.hasFocus()) start();
    return () => {
      stop();
      window.removeEventListener("focus", start);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [booted, active, refreshGpu]);
}
