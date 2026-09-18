# Third-party notices

Shadowfetch Voice Studio is built from the open-source components below. Versions are those pinned in
`backend/requirements/*.lock.txt`, `frontend/package.json`/`package-lock.json` and `src-tauri/Cargo.lock`.
Only the Rust shell, the JavaScript bundle and our own Python sources are inside the `.deb`; the Python
packages are installed into the user's runtime by `scripts/bootstrap.sh`, and model weights are downloaded by
the user (see `MODEL_LICENSES.md`). Full license texts are available from each project's repository and in the
installed packages' metadata (`<env>/lib/python3.12/site-packages/*.dist-info/`).

## System components used at runtime (not redistributed)

| Component | License | Note |
|---|---|---|
| FFmpeg / ffprobe (Ubuntu `ffmpeg` package) | LGPL-2.1-or-later / GPL-2.0-or-later (Ubuntu build is GPL-enabled, includes libmp3lame LGPL) | invoked as a separate process; the `.deb` depends on the system package |
| PortAudio (`libportaudio2`) | MIT-style | loaded by `sounddevice`; optional (FFmpeg/PulseAudio fallback) |
| WebKitGTK, GTK 3 | LGPL-2.1 / BSD-2 | Tauri's Linux webview; system packages |
| NVIDIA driver / CUDA runtime | NVIDIA EULA | CUDA runtime libraries arrive as pip wheels in the user's runtime |

## Python — main environment (worker, Qwen3-TTS, faster-whisper)

| Package | Version | License | Source |
|---|---|---|---|
| PyTorch (torch, torchaudio) | 2.11.0+cu128 | BSD-3-Clause | https://github.com/pytorch/pytorch |
| NVIDIA CUDA runtime wheels (nvidia-*-cu12, triton) | 12.8.4.1 | NVIDIA EULA / MIT (triton) | installed into the user's runtime by bootstrap; never redistributed in the package |
| qwen-tts | 0.1.1 | Apache-2.0 | https://github.com/QwenLM/Qwen3-TTS |
| transformers | 4.57.3 | Apache-2.0 | https://github.com/huggingface/transformers |
| accelerate | 1.12.0 | Apache-2.0 | https://github.com/huggingface/accelerate |
| huggingface_hub | 0.36.2 | Apache-2.0 | https://github.com/huggingface/huggingface_hub |
| faster-whisper | 1.2.1 | MIT | https://github.com/SYSTRAN/faster-whisper |
| CTranslate2 | 4.8.2 | MIT | https://github.com/OpenNMT/CTranslate2 |
| librosa | 0.11.0 | ISC | https://github.com/librosa/librosa |
| numpy | 2.5.3 | BSD-3-Clause | https://numpy.org |
| scipy | 1.18.1 | BSD-3-Clause | https://scipy.org |
| soundfile (bundles libsndfile) | 0.14.0 | BSD-3-Clause (libsndfile: LGPL-2.1-or-later, dynamically linked) | https://github.com/bastibe/python-soundfile |
| sounddevice (uses system PortAudio) | 0.5.6 | MIT (PortAudio: MIT-style) | https://github.com/spatialaudio/python-sounddevice |
| pydantic | 2.13.5 | MIT | https://github.com/pydantic/pydantic |
| onnxruntime | 1.30.0 | MIT | https://github.com/microsoft/onnxruntime |
| einops | 0.8.2 | MIT | https://github.com/arogozhnikov/einops |

## Python — optional Chatterbox environment

| Package | Version | License | Source |
|---|---|---|---|
| chatterbox-tts | 0.1.7 | MIT | https://github.com/resemble-ai/chatterbox |
| resemble-perth (Perth watermarker) | git+https://github.com/resemble-ai/Perth.git@ff1c8ac55a976971245cdd53c18d6131ca00d993 | MIT | https://github.com/resemble-ai/Perth |
| transformers | 5.2.0 | Apache-2.0 |  |
| diffusers | 0.29.0 | Apache-2.0 |  |
| s3tokenizer | 0.3.0 | Apache-2.0 |  |
| conformer | 0.3.2 | MIT |  |
| pyloudnorm | 0.2.0 | MIT |  |
| omegaconf | 2.3.1 | BSD-3-Clause |  |
| pykakasi | 2.3.0 | GPL-3.0-or-later (imported by chatterbox for Japanese text; not used by the English-only Turbo path in this app) | https://github.com/miurahr/pykakasi |
| spacy-pkuseg | 1.0.1 | MIT |  |

## Rust (desktop shell)

| Crate | Version | License |
|---|---|---|
| tauri | 2 | MIT OR Apache-2.0 |
| tauri-build | 2 | MIT OR Apache-2.0 |
| tauri-plugin-dialog | 2 | MIT OR Apache-2.0 |
| tauri-plugin-opener | 2 | MIT OR Apache-2.0 |
| tokio | 1 | MIT |
| serde / serde_json | 1 | MIT OR Apache-2.0 |
| uuid | 1 | MIT OR Apache-2.0 |
| log | 0.4 | MIT OR Apache-2.0 |

## JavaScript (frontend, bundled into the app)

| Package | Version | License |
|---|---|---|
| react | 18.3.1 | MIT |
| react-dom | 18.3.1 | MIT |
| vite | 6.4.3 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| tailwindcss | 4.3.3 | MIT |
| @tailwindcss/vite | 4.3.3 | MIT |
| lucide-react | 1.47.0 | ISC |
| zustand | 5.0.15 | MIT |
| @tauri-apps/api | 2.11.1 | MIT OR Apache-2.0 |
| vitest | 3.2.7 | MIT |
| @testing-library/react | 16.3.3 | MIT |
| jsdom | 26.1.0 | MIT |

## Models

See `MODEL_LICENSES.md` (Qwen3-TTS: Apache-2.0; Chatterbox-Turbo + Perth: MIT; faster-whisper CTranslate2 conversions of OpenAI Whisper: MIT).

## Obligations summary

- MIT / BSD / ISC / Apache-2.0 components: keep copyright and license notices (this file + package metadata); Apache-2.0 additionally requires noting modifications (none are made to those packages).
- LGPL components (libsndfile inside the soundfile wheel; FFmpeg/WebKitGTK as system packages): used unmodified as dynamically linked libraries or separate processes; users can replace them.
- pykakasi (GPL-3.0-or-later) is a transitive dependency of `chatterbox-tts` installed only into the optional Chatterbox runtime on the user's machine; it is not linked into or shipped with the packaged application.
- No component's terms are altered by this project. Shadowfetch Voice Studio's own code: see the repository `LICENSE`.
