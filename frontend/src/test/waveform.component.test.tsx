import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Waveform } from "@/components/audio/Waveform";

const peaks: Array<[number, number]> = Array.from({ length: 200 }, (_, i) => [-Math.abs(Math.sin(i / 7)), Math.abs(Math.sin(i / 7))]);

describe("<Waveform />", () => {
  it("exposes the selection handles as sliders and nudges them from the keyboard", () => {
    const onSelectionChange = vi.fn();
    render(<Waveform peaks={peaks} duration={20} selectable selection={{ start: 2, end: 4 }} onSelectionChange={onSelectionChange} currentTime={1} />);
    const start = screen.getByRole("slider", { name: "Selection start" });
    const end = screen.getByRole("slider", { name: "Selection end" });
    expect(start).toHaveAttribute("aria-valuenow", "2");
    expect(end).toHaveAttribute("aria-valuemax", "20");

    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 2.05, end: 4 });
    fireEvent.keyDown(start, { key: "ArrowLeft", shiftKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 1.5, end: 4 });
    fireEvent.keyDown(end, { key: "ArrowRight", shiftKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 2, end: 4.5 });
    fireEvent.keyDown(end, { key: "End" });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 2, end: 20 });
    fireEvent.keyDown(start, { key: "Home" });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 0, end: 4 });
  });

  it("describes itself for assistive tech and shows the time readout + zoom controls", () => {
    render(<Waveform peaks={peaks} duration={12.5} currentTime={3.25} selectable selection={{ start: 1, end: 2.5 }} />);
    expect(screen.getByRole("img", { name: /Waveform, 0:12\.5 long, selection 0:01\.0 to 0:02\.5/ })).toBeInTheDocument();
    expect(screen.getByText(/0:03\.3 \/ 0:12\.5/)).toBeInTheDocument();
    expect(screen.getByText(/Selection 0:01\.0 – 0:02\.5 \(1\.50 s\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Zoom out/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Zoom in/ })).toBeEnabled();
    expect(screen.getByText("1.0×")).toBeInTheDocument();
  });

  it("renders no handles when not selectable", () => {
    render(<Waveform peaks={peaks} duration={5} selection={{ start: 1, end: 2 }} />);
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });
});
