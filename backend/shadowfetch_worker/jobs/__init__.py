"""Importing this package registers every RPC method."""
from . import system  # noqa: F401

for _mod in ("audio", "record", "transcribe", "engines", "tts", "voices", "projects", "library", "export", "models", "backup", "dataset", "speak"):
    try:
        __import__(f"{__name__}.{_mod}")
    except ImportError as e:  # a missing optional module must not take the whole worker down
        import logging
        logging.getLogger("jobs").warning("job module %s not loaded: %s", _mod, e)
