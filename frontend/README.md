# Shadowfetch Voice Studio — frontend

React 18 + TypeScript + Vite 6 + Tailwind v4 UI for the Tauri 2 desktop shell. It never talks to the
Python worker directly: every call goes through the Rust commands (`worker_request`, `worker_cancel`, …)
and the shell events (`worker://progress`, `worker://event`, `worker://status`, `runtime://log`).

```
npm install
npm run dev        # Vite on http://localhost:1420 (strictPort) — Tauri points its devUrl here
npm run build      # tsc --noEmit + vite build → dist/ (Tauri frontendDist)
npm test -- --run  # vitest (jsdom)
npm run typecheck
```

Requires Node ≥ 20.19 (22.x works). No web fonts or CDN assets; the font stack is
`Inter, "Segoe UI", system-ui, sans-serif`.

## Layout

| path | what |
|------|------|
| `src/lib/protocol.ts` | Types for every method/params/result/event in `docs/PROTOCOL.md` plus the Rust command surface (`Methods`, `ShellCommands`, `ShellEvents`). |
| `src/lib/api.ts` | **The only module that imports `@tauri-apps/api`.** `request(method, params, {onProgress, signal})` generates a UUID id, fans progress events out by id, and normalises every failure into `WorkerError {code, message, details, recoverable}`. Typed helpers live under `api.<namespace>.*`; `api.shell.*` wraps the Rust commands; `api.events.on('record.level', cb)` returns an unsubscribe function. |
| `src/lib/devmock.ts` | Browser-preview mock. Used only when `import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)`; the production bundle does not contain it. Every value is labelled "(mock)" and the header shows a **PREVIEW MOCK** badge. |
| `src/styles/theme.css` | Tailwind v4 `@theme` tokens (colours, radii, font stack, shadows) and base styles. |
| `src/components/ui/` | Design system (see below). Import from `@/components/ui`. |
| `src/components/audio/` | `Waveform`, `PlayerBar`, `usePlayer`, `waveformMath` (pure helpers). |
| `src/components/shell/` | Top bar (Speak · Voices · gear), worker banner (only when the engine is down), error boundary. |
| `src/components/settings/AudioDevices.tsx` | Device pickers + test tone, shared by Settings and Setup. |
| `src/components/model-manager/ModelRow.tsx` | Download (with license/repo/size confirmation) / Cancel / Verify / Use existing folder / Remove for one model. |
| `src/store/appStore.ts` | zustand store: page routing, diagnostics, settings, engines, models, worker status, GPU status, live engine/model events, loaders with error toasts (`handleError`). |
| `src/store/modelOps.ts` | Long-running model/engine operations that must survive page changes (downloads with byte progress, load/unload). |
| `src/store/modelSetup.ts` | `readiness()` / `ensureModels("speak" \| "clone")`: what an action needs, and the one "Voice Studio needs its local model" dialog (`features/setup/ModelSetupDialog.tsx`). |
| `src/store/voicesStore.ts` | The saved voices, shared by the voice menu, Voices and Clone Voice. |
| `src/store/useGpuPolling.ts` | GPU/engine status polling — only on Settings, System check and the project editor. |
| `src/lib/friendlyErrors.ts` | Worker error codes and sample findings → plain language (the structured error is kept for the "Technical details" disclosure and the log). |
| `src/features/speak/` | `speakStore` (plan → generate → assemble → remember → play, cancel, autosave + draft mirror, Recent), `VoicePicker`, `SpeechPlayer`, `RecentList`, `saveAudio`. |
| `src/features/voices/` | Clone Voice (`clone/`: `CloneVoiceDialog`, `RecordStep`, `FileStep`, `SampleEditor`, `cloneFlow`), `EditSampleDialog`, `cloneStore`, recorder state machine, transcript/processing helpers, `DatasetWorkspace`. |
| `src/features/settings/` | Speak's settings: `SpeechBasics`, `SpeakAdvanced` (engine-declared controls only), `SaveAudioAdvanced`. |
| `src/features/create/`, `src/features/library/` | The project editor and Projects (advanced tools, from Settings → Advanced → Tools). |
| `src/pages/` | `SpeakPage` (default), `VoicesPage`, `SettingsPage`; advanced: `SetupPage` (system check), `LibraryPage` (Projects), `CreatePage` (project editor). |

## Design tokens

Work area `#f7f5f1`, panel `#ffffff`, border `#e6e2dc`, text `#1f2328`,
muted `#656d7a` (≥ 4.5:1 on both backgrounds), accent `#2f6fe4` / hover `#2559c4`, success `#1a7f4b`,
warn `#b45309`, danger `#c62828`. A dark palette with the same token names follows the desktop's
`prefers-color-scheme` (GNOME, COSMIC). Use `bg-hover` / `bg-track` instead of black/white alpha washes. Panels use 12 px radius (`.panel`), controls 8 px and ≥ 40 px tall
(`.control`). Spacing follows Tailwind's 4 px base — use even steps (`gap-2` = 8 px, `p-4` = 16 px, …)
to stay on the 8 px grid. Focus rings: `:focus-visible` outline 2 px accent with offset.

## Components (`@/components/ui`)

`Button` (primary/soft/secondary/ghost/danger; sm/md/lg; `loading`; `icon`), `IconButton` (needs `label`),
`Card`/`Panel` (title, description, actions, footer, `flush`), `Input`, `Textarea`, `Select` (native),
`Switch`, `Checkbox`, `Slider` (numeric readout + reset) and `ControlSlider` (bound to an engine-declared
`ControlSpec`; renders nothing for non-numeric specs), `Tabs`/`TabPanel`, `Dialog` (focus trap, Esc,
focus restore) and `ConfirmDialog`, `ToastProvider` + `toast.success/error/info/warning`, `ProgressBar`
("3 of 12 segments" from measured counts, indeterminate otherwise), `StatusPill`, `EmptyState`,
`Tooltip`, `Kbd`, `Meter` (dBFS, peak hold, latched CLIP), `Spinner`, `Collapsible`.

Rule from the architecture doc: the UI renders **only** controls an engine declared in its
`Capabilities`. Use `ControlSlider`/`Select` driven by `capabilities.controls`, never hard-coded knobs.

## Waveform

```tsx
const player = usePlayer({ path: take.path, selection, restrictToSelection: true });
<Waveform peaks={peaks} duration={duration} currentTime={player.currentTime} onSeek={player.seek}
          selectable selection={selection} onSelectionChange={setSelection} />
<PlayerBar player={player} hasSelection={!!selection} />
```

Peaks come from `audio.peaks` (`[[min,max], …]`). Click seeks, drag selects (when `selectable`), handles
are draggable and keyboard-nudgeable (← → 0.05 s, shift 0.5 s, Home/End), zoom 1×–16× with ctrl+wheel or
the buttons, horizontal scroll when zoomed. `usePlayer` wraps an `HTMLAudioElement` fed by the Tauri asset
protocol (`api.shell.fileSrc(path)`) and can restrict/loop playback to the selection.

## Routing and shortcuts

Pages are switched through the store: `useAppStore.getState().navigate('voices')`. The main navigation has
two entries (Speak, Voices) plus the Settings gear; `setup`, `projects` and `editor` are reached from Settings.
`RouteParams` carries `projectId`, `action` (`new`, editor only) and `section` (Settings anchor).
Clone Voice opens from anywhere with `useCloneStore.getState().start()`. Keys: **Ctrl+Enter** speaks and **Esc**
stops on the Speak page (Ctrl+Enter / Ctrl+Shift+Enter / Esc also drive the project editor).

## Tests

`src/__tests__/speak.flow.test.tsx` (launch → voice → text → Ctrl+Enter → plan/generate/assemble/remember →
auto-play → Save Audio; cancel, repeated presses, voice changes, errors, model setup, offline, restore),
`clone.flow.test.tsx` (record / import → automatic range + transcription → create; problems, Edit Sample, closing
mid-operation), `voices.page.test.tsx`, `settings.advanced.test.tsx` (capability-driven controls),
`speak.logic.test.ts` (readiness, error wording, progress labels), plus the project-editor, Projects, setup and
recorder suites. `src/test/`: `api.test.ts`, waveform tests, `ui.test.tsx` (design system, dialog focus
regression), `app.test.tsx` (App smoke render through the dev mock).

## Shell contract this UI relies on

- `worker_request({ id, method, params })` resolves with the result or rejects with the protocol error object.
- `worker://progress` payloads carry the request `id`; `worker://event` is `{ event, data }`.
- `pick_*` dialogs resolve `null` (or `[]` for `pick_audio_files`) when cancelled.
- Tauri CSP must allow `media-src asset: http://asset.localhost` so `<audio>` can play local files.
