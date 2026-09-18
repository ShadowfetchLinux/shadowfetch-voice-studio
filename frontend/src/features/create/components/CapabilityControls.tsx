import type { ControlSpec } from "@/lib/protocol";
import { Input, Select } from "@/components/ui/Field";
import { Collapsible } from "@/components/ui/Feedback";
import { ControlSlider } from "@/components/ui/Slider";
import { Switch } from "@/components/ui/Toggle";

export interface CapabilityControlsProps {
  /** `Capabilities.controls` or `Capabilities.post_processing`; nothing renders when empty. */
  specs: readonly ControlSpec[];
  values: Record<string, unknown>;
  onChange: (id: string, value: unknown) => void;
  disabled?: boolean;
  /** Title of the disclosure that holds `advanced: true` controls. */
  advancedTitle?: string;
}

/** One control rendered strictly from its `ControlSpec` (slider / number / switch / select). */
export function CapabilityControl({ spec, value, onChange, disabled }: { spec: ControlSpec; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  if (spec.type === "bool") {
    return <Switch label={spec.label} description={spec.description} checked={Boolean(value ?? spec.default)} onChange={onChange} disabled={disabled} />;
  }
  if (spec.type === "enum") {
    const options = (spec.options ?? []).map((o) => ({ value: String(o.value), label: o.label }));
    const current = String(value ?? spec.default ?? options[0]?.value ?? "");
    return (
      <Select
        label={spec.label}
        hint={spec.description}
        options={options}
        value={current}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          const match = (spec.options ?? []).find((o) => String(o.value) === raw);
          onChange(match ? match.value : raw);
        }}
      />
    );
  }
  if (spec.min != null && spec.max != null) {
    const num = typeof value === "number" ? value : typeof spec.default === "number" ? spec.default : spec.min;
    return <ControlSlider spec={spec} value={num} onChange={onChange} disabled={disabled} />;
  }
  return (
    <Input
      label={spec.label}
      hint={spec.description}
      type="number"
      step={spec.step ?? (spec.type === "int" ? 1 : "any")}
      value={typeof value === "number" ? value : typeof spec.default === "number" ? spec.default : ""}
      disabled={disabled}
      onChange={(e) => {
        const v = spec.type === "int" ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
        if (Number.isFinite(v)) onChange(v);
      }}
    />
  );
}

/**
 * Renders exactly the controls an engine declared — never a hard-coded knob. Basic controls appear inline,
 * `advanced` ones inside a Collapsible. Returns null when the engine declared nothing.
 */
export function CapabilityControls({ specs, values, onChange, disabled, advancedTitle = "Advanced" }: CapabilityControlsProps) {
  if (specs.length === 0) return null;
  const basic = specs.filter((c) => !c.advanced);
  const advanced = specs.filter((c) => c.advanced);
  const render = (c: ControlSpec) => <CapabilityControl key={c.id} spec={c} value={values[c.id]} onChange={(v) => onChange(c.id, v)} disabled={disabled} />;
  return (
    <div className="flex flex-col gap-4" data-testid="capability-controls">
      {basic.map(render)}
      {advanced.length > 0 && (
        <Collapsible title={advancedTitle} description={`${advanced.length} engine-declared advanced setting${advanced.length === 1 ? "" : "s"}`}>
          <div className="flex flex-col gap-4 pt-3">{advanced.map(render)}</div>
        </Collapsible>
      )}
    </div>
  );
}
