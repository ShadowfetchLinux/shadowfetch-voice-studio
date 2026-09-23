# User guide

Shadowfetch Voice Studio is a notepad whose text can speak in any voice you have cloned: **choose a voice → type →
Speak**. Everything runs on your computer.

## Speak

The app opens here, with the cursor in the editor.

- **Voice** — pick a voice the way you would pick a font. The menu also has **Clone New Voice…** and **Manage Voices**.
  The last voice you used is remembered.
- **The editor** — type or paste any amount of text. It is saved as you type and comes back after a restart
  (undo/redo, select all and spell checking work as usual).
- **Speak** (or **Ctrl+Enter**) — generates the speech and plays it as soon as it is ready. For longer text the button
  shows progress ("Generating speech — 3 of 12"). **Stop** (or **Esc**) cancels; anything already finished is kept, so
  pressing Speak again continues quickly.
- Change a sentence and press Speak again: only what changed is generated again. Press Speak without changing anything
  and you get a fresh reading of the whole text. Switching to another voice always regenerates everything with that voice.
- **Generated speech** — play/pause, scrub, and **Save Audio**. Save Audio writes a 24-bit WAV by default; the arrow
  next to it saves MP3 or FLAC instead. Saved files are marked as AI-generated in their metadata (Settings can turn that off).
- **Recent** — your last results. Click one to play it again; the × removes it.

The first time Speak needs the voice model, Voice Studio shows what it will download (name, size, source, license) and
waits for you to click **Download model**. In offline mode it explains that downloads are blocked instead.

## Clone a voice

**Clone Voice** (on Speak or Voices) offers two choices:

- **Record Voice** — pick your microphone, press the big button and read the text shown (or anything you like) naturally
  for 20–30 seconds, then stop. A live level shows that the microphone hears you; you are told if it is too loud or too quiet.
- **Use Audio File** — choose a WAV, MP3, FLAC, OGG, M4A or other common audio file, or drop it on the window.
  Your file is copied; the original is never changed.

Voice Studio then prepares the sample by itself: it finds the clearest 8–15 seconds (whole phrases, starting and
ending between words), checks the level, clipping, silence and background noise, and writes down the words spoken in
that part with the local speech-recognition model. When it is done you see **Voice sample ready**: play the sample,
give the voice a name, confirm that it is your voice or that you have permission to clone it, and press **Create Voice**.
The new voice is selected on Speak right away.

If the sample has problems they are explained in plain words (for example "The recording is very quiet") with
**Try Anyway**, **Choose Another File** / **Record Again**, and **Edit Sample**. A sample without usable speech cannot be
used. When no clean part can be found automatically, the sample editor opens so you can choose it.

**Edit Sample** is optional: drag across the waveform to choose the part to clone from, correct the words spoken in it
(the voice is cloned from the audio *and* these exact words), and optionally clean the sample up (even out the volume,
trim silence, remove rumble — always applied to a copy).

## Voices

Your voices with their sample length and date. **Play Sample** plays the part the voice is cloned from; **Use Voice**
selects it on Speak. The **⋯** menu has **Rename**, **Add Recording** (another sample; the voice then speaks with it),
**Edit Sample**, **Delete** (speech you already made is kept; your original recordings stay on disk), and
**Export training data…** (see `docs/FINETUNING.md`).

## Settings

- **Speech** — play speech automatically; the format Save Audio uses.
- **Privacy** — **offline mode** blocks every network request; installed models keep working.
- **Microphone & speakers** — devices, a test tone, and hearing yourself while recording (headphones only).
- **Advanced** (collapsed) — for experienced users:
  - **Speech generation** — engine (Automatic uses Qwen3-TTS), language, the selected engine's own settings (only
    settings the engine actually supports are shown), seed, pauses between sentences and paragraphs, the longest piece
    generated at once, spelling out numbers, and pronunciation substitutions. These apply to Speak.
  - **Save Audio details** — WAV bit depth, MP3 bitrate, a named loudness target (Podcast −16, Streaming −14,
    EBU R128 −23 LUFS, measured after saving), AI-generated metadata.
  - **Models & engines** — download / verify / use an existing folder / remove models; load or unload engines; idle unload.
  - **Recording format**, **Transcription, performance & defaults**, **Storage** (usage, clear regenerable caches).
  - **Tools** — **Projects** and the project editor (long scripts as saved projects with per-sentence takes, engine
    comparison, backups and detailed exports), the **System check** (FFmpeg, GPU/CUDA, engine runtime, devices, storage),
    and a redacted **diagnostics bundle**.

## Keyboard

**Ctrl+Enter** speak · **Esc** stop (or close a dialog) · in the sample editor: arrows nudge a selected trim handle
(Shift for larger steps), Ctrl+wheel zooms the waveform.
