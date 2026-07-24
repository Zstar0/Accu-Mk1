"""Vendored copy of the COA Builder conformance engine.

MIRROR-ONLY. Do not edit the engine modules in place. See VENDORED.md.
Source: coabuilder @ 2c95762 (v2.14.8).
"""
from .conformance import ConformanceEngine
from .generic_assay_engine import GenericAssayEngine

__all__ = ["ConformanceEngine", "GenericAssayEngine"]
VENDORED_SOURCE_COMMIT = "2c95762279b613be28d35a891f822b6e04a71e0c"
VENDORED_SOURCE_VERSION = "2.14.8"
