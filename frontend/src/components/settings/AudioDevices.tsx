import { useState } from "react";
import { RefreshCw, Volume2 } from "lucide-react";
import { api } from "@/lib/api";
import type { Device } from "@/lib/protocol";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Toggle";
import { handleError, toast, useAppStore } from "@/store/appStore";

const SAMPLE_RATES = [44100, 48000, 96000];
const SUBTYPES: Array<{ value: string; label: string }> = [
  { value: "PCM_16", label: "16-bit PCM" },
  { value: "PCM_24", label: "24-bit PCM (recommended)" },
  { value: "FLOAT", label: "32-bit float" },
];

function deviceLabel(d: Device, technical: boolean): string {
  return technical ? `${d.name} (${d.hostapi}${d.default_samplerate ? `, ${Math.round(d.default_samplerate)} Hz` : ""})` : d.name;
}

export interface AudioDevicesProps {
  /** Also show record sample rate / subtype. */
  showRecordFormat?: boolean;
  /** Plain labels and hints for the everyday Settings card (no host APIs, sample rates or monitoring details). */
  simple?: boolean;
}

/** Input/output device pickers backed by `system.diagnostics.audio`, with a test tone. */
export function AudioDevices({ showRecordFormat = true, simple = false }: AudioDevicesProps) {
  const diagnostics = useAppStore((s) => s.diagnostics);
  const loading = useAppStore((s) => s.diagnosticsLoading);
  const loadDiagnostics = useAppStore((s) => s.loadDiagnostics);
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const [testing, setTesting] = useState(false);

  const audio = diagnostics?.audio;
  const inputs = audio?.inputs ?? [];
  const outputs = audio?.outputs ?? [];
  const inputValue = settings?.record_device_index != null ? String(settings.record_device_index) : "";
  const outputValue = settings?.output_device_index != null ? String(settings.output_device_index) : "";

  const testTone = async () => {
    setTesting(true);
    try {
      const r = await api.audio.playDeviceTest({ device_index: settings?.output_device_index ?? null });
      if (r.ok) toast.success("Test tone played");
      else toast.warning("Test tone did not play", "The worker reported ok=false.");
    } catch (err) {
      handleError(err, "Test tone failed");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {audio?.error && (
        <p className="text-[13px] text-warn" role="alert">
          {simple ? "Your audio devices couldn't be listed. Check that the microphone is connected, then press Rescan." : `Audio device enumeration failed: ${audio.error}`}
        </p>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Select
          label={simple ? "Microphone" : "Input device (microphone)"}
          value={inputValue}
          placeholder={inputs.length ? `System default${audio?.default_input != null ? ` (${inputs.find((d) => d.index === audio.default_input)?.name ?? "#" + audio.default_input})` : ""}` : "No input devices found"}
          options={inputs.map((d) => ({ value: String(d.index), label: deviceLabel(d, !simple) }))}
          onChange={(e) => void saveSettings({ record_device_index: e.target.value === "" ? null : Number(e.target.value) }, { silent: true })}
          disabled={!settings || inputs.length === 0}
          hint={simple ? "Used when you record a voice." : "Used by the recorder. PortAudio/PulseAudio device as reported by the worker."}
        />
        <Select
          label={simple ? "Speakers" : "Output device (playback and test tone)"}
          value={outputValue}
          placeholder={outputs.length ? `System default${audio?.default_output != null ? ` (${outputs.find((d) => d.index === audio.default_output)?.name ?? "#" + audio.default_output})` : ""}` : "No output devices found"}
          options={outputs.map((d) => ({ value: String(d.index), label: deviceLabel(d, !simple) }))}
          onChange={(e) => void saveSettings({ output_device_index: e.target.value === "" ? null : Number(e.target.value) }, { silent: true })}
          disabled={!settings || outputs.length === 0}
          hint={simple ? "Speech plays through your system's default output; the test tone uses this one." : "In-app playback uses the system default; this device receives the worker's test tone."}
        />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Button icon={<Volume2 />} loading={testing} onClick={() => void testTone()} disabled={!diagnostics}>
          Play test tone
        </Button>
        <Button variant="ghost" icon={<RefreshCw />} loading={loading} onClick={() => void loadDiagnostics()}>
          Rescan devices
        </Button>
      </div>
      <Switch
        label={simple ? "Hear yourself while recording" : "Input monitoring"}
        description="Plays the microphone back while recording. Use headphones — speakers will feed back into the mic."
        checked={settings?.monitor_input ?? false}
        onChange={(v) => void saveSettings({ monitor_input: v }, { silent: true })}
        disabled={!settings}
      />
      {showRecordFormat && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Select
            label="Recording sample rate"
            value={String(settings?.record_sample_rate ?? 48000)}
            options={SAMPLE_RATES.map((r) => ({ value: String(r), label: `${r} Hz${r === 48000 ? " (recommended)" : ""}` }))}
            onChange={(e) => void saveSettings({ record_sample_rate: Number(e.target.value) }, { silent: true })}
            disabled={!settings}
            hint="The worker negotiates the closest rate the device supports and reports it when recording starts."
          />
          <Select
            label="Recording bit depth"
            value={settings?.record_subtype ?? "PCM_24"}
            options={SUBTYPES}
            onChange={(e) => void saveSettings({ record_subtype: e.target.value }, { silent: true })}
            disabled={!settings}
          />
        </div>
      )}
    </div>
  );
}
