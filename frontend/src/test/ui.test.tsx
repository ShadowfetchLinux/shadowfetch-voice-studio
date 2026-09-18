import { describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Button,
  Checkbox,
  Collapsible,
  ConfirmDialog,
  ControlSlider,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  Meter,
  ProgressBar,
  Select,
  Slider,
  StatusPill,
  Switch,
  Tabs,
  Textarea,
  ToastProvider,
  toast,
  useToastStore,
} from "@/components/ui";
import type { ControlSpec } from "@/lib/protocol";

describe("design system", () => {
  it("renders form controls with labels and 40px-class control heights", () => {
    render(
      <div>
        <Input label="Name" hint="hint" />
        <Textarea label="Notes" />
        <Select label="Device" options={[{ value: "0", label: "Mic" }]} />
        <Button>Go</Button>
        <IconButton label="Close">x</IconButton>
      </div>,
    );
    expect(screen.getByLabelText("Name")).toHaveClass("control");
    expect(screen.getByLabelText("Device")).toHaveClass("control");
    expect(screen.getByLabelText("Notes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go" })).toHaveClass("h-10");
    expect(screen.getByRole("button", { name: "Close" })).toHaveClass("size-10");
  });

  it("Button loading state disables the button and marks it busy", () => {
    render(<Button loading>Save</Button>);
    const b = screen.getByRole("button", { name: /Save/ });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute("aria-busy", "true");
  });

  it("Switch and Checkbox toggle through their accessible roles", async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn();
    const onCheck = vi.fn();
    render(
      <div>
        <Switch label="Offline" checked={false} onChange={onSwitch} />
        <Checkbox label="Agree" checked={false} onChange={onCheck} />
      </div>,
    );
    await user.click(screen.getByRole("switch", { name: "Offline" }));
    expect(onSwitch).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole("checkbox", { name: "Agree" }));
    expect(onCheck).toHaveBeenCalledWith(true);
  });

  it("ControlSlider only renders numeric engine-declared controls", () => {
    const float: ControlSpec = { id: "temperature", label: "Sampling temperature", type: "float", min: 0.1, max: 1.5, step: 0.05, default: 0.9 };
    const flag: ControlSpec = { id: "x", label: "Flag", type: "bool", default: false };
    const onChange = vi.fn();
    const { container } = render(
      <div>
        <ControlSlider spec={float} value={undefined} onChange={onChange} />
        <ControlSlider spec={flag} value={undefined} onChange={onChange} />
      </div>,
    );
    expect(screen.getByRole("slider", { name: "Sampling temperature" })).toHaveValue("0.9");
    expect(container.querySelectorAll('input[type="range"]')).toHaveLength(1);
    render(<Slider label="Speed" value={1.1} defaultValue={1} min={0.8} max={1.25} step={0.01} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Reset to default" })).toBeInTheDocument();
  });

  it("Tabs support arrow-key navigation", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Tabs items={[{ key: "a", label: "A" }, { key: "b", label: "B" }]} value="a" onChange={onChange} />);
    screen.getByRole("tab", { name: "A" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("Dialog traps focus, closes on Escape and restores focus", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <div>
        <button>outside</button>
        <Dialog open onClose={onClose} title="Hello" footer={<button>ok</button>}>
          <input aria-label="inside" />
        </Dialog>
      </div>,
    );
    const dialog = screen.getByRole("dialog", { name: "Hello" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("ConfirmDialog runs the confirm callback", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open onCancel={() => {}} onConfirm={onConfirm} title="Remove?" confirmLabel="Remove" destructive>
        <p>Gone for good.</p>
      </ConfirmDialog>,
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("ProgressBar shows measured counts or an indeterminate sweep", () => {
    const { rerender } = render(<ProgressBar label="Generating" current={3} total={12} unit="segments" />);
    expect(screen.getByText("3 of 12 segments")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "3");
    rerender(<ProgressBar label="Waiting" />);
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });

  it("Meter reports dBFS and latches clipping until reset", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Meter peakDbfs={-6.5} rmsDbfs={-20} clipped={false} />);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "-6.5 dBFS");
    rerender(<Meter peakDbfs={0} rmsDbfs={-3} clipped />);
    const clip = screen.getByRole("button", { name: "CLIP" });
    expect(clip).toHaveAttribute("aria-pressed", "true");
    rerender(<Meter peakDbfs={-30} rmsDbfs={-40} clipped={false} />);
    expect(clip).toHaveAttribute("aria-pressed", "true"); // latched
    await user.click(clip);
    expect(clip).toHaveAttribute("aria-pressed", "false");
  });

  it("toasts render and dismiss", async () => {
    const user = userEvent.setup();
    useToastStore.getState().clear();
    render(<ToastProvider />);
    act(() => {
      toast.error("Failed", "MODEL_MISSING");
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Collapsible, StatusPill and EmptyState render their content", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Collapsible title="Advanced">
          <p>hidden body</p>
        </Collapsible>
        <StatusPill tone="success" dot>
          running
        </StatusPill>
        <EmptyState title="Nothing here" text="Add something" action={<Button>Add</Button>} />
      </div>,
    );
    expect(screen.queryByText("hidden body")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Advanced/ }));
    expect(screen.getByText("hidden body")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });
});
