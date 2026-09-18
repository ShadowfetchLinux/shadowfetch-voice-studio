import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => cleanup());

// jsdom lacks a few browser APIs the components touch.
if (typeof window !== "undefined") {
  if (!("ResizeObserver" in window)) {
    class RO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  }
  if (!window.HTMLCanvasElement.prototype.getContext || process.env.VITEST) {
    // canvas is not implemented in jsdom; a no-op 2D context keeps Waveform renderable.
    window.HTMLCanvasElement.prototype.getContext = function () {
      const noop = () => {};
      return new Proxy({}, { get: (_t, prop) => (prop === "measureText" ? () => ({ width: 0 }) : noop) }) as unknown as CanvasRenderingContext2D;
    } as unknown as typeof window.HTMLCanvasElement.prototype.getContext;
  }
  if (!window.HTMLMediaElement.prototype.play || process.env.VITEST) {
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.HTMLMediaElement.prototype.pause = () => {};
    window.HTMLMediaElement.prototype.load = () => {};
  }
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
}
