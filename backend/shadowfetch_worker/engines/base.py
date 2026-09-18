"""Engine adapter contract. Everything the UI shows about an engine comes from `Capabilities`."""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field


class Language(BaseModel):
    code: str                 # BCP-47-ish short code used by the app, e.g. "en"
    label: str                # "English"
    engine_value: str         # exact string the engine API expects, e.g. "English" or "en"


class ReferenceRequirements(BaseModel):
    needs_transcript: bool
    min_seconds: float
    max_seconds: float
    recommended_seconds: tuple[float, float]
    sample_rate: int
    channels: int = 1
    notes: str = ""


class ControlSpec(BaseModel):
    id: str
    label: str
    type: Literal["float", "int", "bool", "enum"]
    default: Any
    min: float | None = None
    max: float | None = None
    step: float | None = None
    options: list[dict[str, Any]] | None = None     # for enum: [{value, label}]
    description: str = ""
    advanced: bool = False


class TagSpec(BaseModel):
    token: str
    label: str
    description: str = ""


class Capabilities(BaseModel):
    id: str
    name: str
    version: str                       # adapter/package version
    model_id: str                      # registry model id
    model_repo: str
    output_sample_rate: int
    languages: list[Language]
    reference: ReferenceRequirements
    controls: list[ControlSpec] = Field(default_factory=list)
    tags: list[TagSpec] = Field(default_factory=list)
    max_chars_per_request: int
    supports_cancel: bool
    supports_seed: bool
    supports_reusable_prompt: bool
    supports_multi_reference: bool = False
    watermark: str | None = None       # e.g. "perth" for Chatterbox
    post_processing: list[ControlSpec] = Field(default_factory=list)   # app-side (ffmpeg) options, labelled as such
    cancel_granularity: Literal["segment", "token"] = "segment"
    device: str = "cuda"
    notes: str = ""
    license: str = ""


class GenerateResult(BaseModel):
    path: str
    sample_rate: int
    duration_s: float
    seed: int | None = None
    elapsed_s: float
    warnings: list[str] = Field(default_factory=list)


class EngineAdapter(ABC):
    """Runs inside an engine-host process. One instance per process."""

    id: str = ""

    @abstractmethod
    def capabilities(self) -> Capabilities: ...

    @abstractmethod
    def load(self, model_dir: Path, device: str = "cuda", dtype: str = "bfloat16", progress=None) -> dict[str, Any]:
        """Load weights. Returns {revision, vram_bytes?, load_ms}."""

    @abstractmethod
    def unload(self) -> None: ...

    @abstractmethod
    def loaded(self) -> bool: ...

    def prepare_reference(self, reference_path: Path, transcript: str, language: str, cache_path: Path) -> dict[str, Any]:
        """Build a reusable engine-specific prompt for a reference. Optional; returns {path, meta}."""
        raise NotImplementedError

    @abstractmethod
    def generate(self, text: str, language: str, reference_path: Path, transcript: str, out_path: Path,
                 settings: dict[str, Any], seed: int | None = None, prompt_cache_path: Path | None = None,
                 cancel_check=None) -> GenerateResult: ...

    def health(self) -> dict[str, Any]:
        return {"loaded": self.loaded()}
