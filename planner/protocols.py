"""Loading, validation and persistence of Philips scanner parameter cards.

Each protocol is a JSON object of the form::

    {
      "INFO PAGE": [ {"parameter": "...", "value": "...", "indent": 0}, ... ],
      "GEOMETRY":  [ ... ],
      ...
    }

The planner treats these files as the single source of truth for acquisition
settings.  The UI edits them in place; every write is preceded by a timestamped
backup so a bad edit is always recoverable.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from datetime import datetime
from typing import Any, Dict, List

SECTION_ORDER = [
    "INFO PAGE",
    "GEOMETRY",
    "CONTRAST",
    "POST/PROC",
    "MOTION",
    "DYN/ANG",
]

# Human labels + planner roles for the protocol cards that ship with the study.
PROTOCOL_ROLES: Dict[str, Dict[str, str]] = {
    "fMRI-Survey-Parameters": {"label": "Survey / Localizer", "role": "structural"},
    "fMRI-SENSE-Reference-Parameters": {"label": "SENSE Reference", "role": "structural"},
    "fMRI-T1-Anatomical-Parameters": {"label": "T1 Anatomical (MPRAGE)", "role": "structural"},
    "fMRI-T2-FLAIR-Parameters": {"label": "T2 FLAIR", "role": "structural"},
    "fMRI-SBRef-Parameters": {"label": "Single-Band Reference", "role": "reference"},
    "fMRI-FieldMap-RevPE-Parameters": {"label": "Field Map (Reverse PE)", "role": "reference"},
    "fMRI-Dummy-Parameters": {"label": "Dummy / Pre-scan EPI", "role": "reference"},
    "fMRI-Base-Parameters": {"label": "Base EPI Template", "role": "functional"},
    "fMRI-GLM-Parameters": {"label": "Aim 1 - GLM / FIR", "role": "functional"},
    "fMRI-MVPA-Parameters": {"label": "Aim 2 - MVPA", "role": "functional"},
    "fMRI-Time-Series-Parameters-V3": {"label": "Aim 3 - Spatiotemporal", "role": "functional"},
}


class ProtocolError(ValueError):
    """Raised when a protocol payload fails structural validation."""


def _slug(filename: str) -> str:
    return os.path.splitext(os.path.basename(filename))[0]


def _safe_slug(slug: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", slug or ""):
        raise ProtocolError(f"Illegal protocol identifier: {slug!r}")
    return slug


class ProtocolStore:
    """Filesystem-backed store for the scanner parameter cards."""

    def __init__(self, directory: str) -> None:
        self.directory = os.path.abspath(directory)
        self.backup_dir = os.path.join(self.directory, ".backups")
        os.makedirs(self.backup_dir, exist_ok=True)

    # ------------------------------------------------------------------ read

    def slugs(self) -> List[str]:
        if not os.path.isdir(self.directory):
            return []
        return sorted(
            _slug(f)
            for f in os.listdir(self.directory)
            if f.endswith(".json") and not f.startswith(".")
        )

    def path_for(self, slug: str) -> str:
        return os.path.join(self.directory, f"{_safe_slug(slug)}.json")

    def load(self, slug: str) -> Dict[str, List[Dict[str, Any]]]:
        with open(self.path_for(slug), "r", encoding="utf-8") as handle:
            return json.load(handle)

    def load_all(self) -> Dict[str, Dict[str, Any]]:
        out: Dict[str, Dict[str, Any]] = {}
        for slug in self.slugs():
            try:
                out[slug] = self.load(slug)
            except (OSError, json.JSONDecodeError) as exc:  # pragma: no cover
                out[slug] = {"_error": str(exc)}
        return out

    def manifest(self) -> List[Dict[str, Any]]:
        """Slug, label, role and a handful of headline values for the picker."""
        entries = []
        for slug in self.slugs():
            try:
                data = self.load(slug)
            except (OSError, json.JSONDecodeError):
                continue
            meta = PROTOCOL_ROLES.get(slug, {"label": slug, "role": "other"})
            entries.append(
                {
                    "slug": slug,
                    "label": meta["label"],
                    "role": meta["role"],
                    "sections": [s for s in data.keys() if not s.startswith("_")],
                    "parameterCount": sum(
                        len(v) for v in data.values() if isinstance(v, list)
                    ),
                    "headline": headline_values(data),
                    "modified": os.path.getmtime(self.path_for(slug)),
                }
            )
        role_rank = {"functional": 0, "reference": 1, "structural": 2, "other": 3}
        entries.sort(key=lambda e: (role_rank.get(e["role"], 9), e["label"]))
        return entries

    # ----------------------------------------------------------------- write

    def save(self, slug: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        validate(payload)
        path = self.path_for(slug)
        backup = None
        if os.path.exists(path):
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            backup = os.path.join(self.backup_dir, f"{slug}.{stamp}.json")
            shutil.copy2(path, backup)
        ordered = order_sections(payload)
        fd, tmp = tempfile.mkstemp(dir=self.directory, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(ordered, handle, indent=4, ensure_ascii=False)
                handle.write("\n")
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        self._prune_backups(slug)
        return {"slug": slug, "backup": os.path.basename(backup) if backup else None}

    def _prune_backups(self, slug: str, keep: int = 25) -> None:
        files = sorted(
            (f for f in os.listdir(self.backup_dir) if f.startswith(f"{slug}.")),
            reverse=True,
        )
        for stale in files[keep:]:
            try:
                os.unlink(os.path.join(self.backup_dir, stale))
            except OSError:  # pragma: no cover
                pass


# ------------------------------------------------------------------ helpers


def validate(payload: Any) -> None:
    if not isinstance(payload, dict) or not payload:
        raise ProtocolError("Protocol must be a non-empty object of sections.")
    for section, rows in payload.items():
        if not isinstance(section, str):
            raise ProtocolError("Section names must be strings.")
        if not isinstance(rows, list):
            raise ProtocolError(f"Section {section!r} must contain a list of rows.")
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                raise ProtocolError(f"{section}[{index}] must be an object.")
            if "parameter" not in row or "value" not in row:
                raise ProtocolError(
                    f"{section}[{index}] requires 'parameter' and 'value' keys."
                )
            if not isinstance(row["parameter"], str):
                raise ProtocolError(f"{section}[{index}].parameter must be a string.")
            row.setdefault("indent", 0)
            if not isinstance(row["indent"], int):
                try:
                    row["indent"] = int(row["indent"])
                except (TypeError, ValueError):
                    row["indent"] = 0
            if not isinstance(row["value"], (str, int, float)):
                row["value"] = str(row["value"])


def order_sections(payload: Dict[str, Any]) -> Dict[str, Any]:
    ordered: Dict[str, Any] = {}
    for section in SECTION_ORDER:
        if section in payload:
            ordered[section] = payload[section]
    for section, rows in payload.items():
        if section not in ordered:
            ordered[section] = rows
    return ordered


def find_value(data: Dict[str, Any], parameter: str, default: str = "") -> str:
    """Case-insensitive lookup of a parameter value across every section."""
    target = parameter.strip().lower()
    for rows in data.values():
        if not isinstance(rows, list):
            continue
        for row in rows:
            if str(row.get("parameter", "")).strip().lower() == target:
                return str(row.get("value", default))
    return default


def parse_tr_te(data: Dict[str, Any]) -> Dict[str, float]:
    """Return the actual TR/TE in milliseconds from 'Act. TR/TE (ms)'."""
    raw = find_value(data, "Act. TR/TE (ms)")
    numbers = re.findall(r"[-+]?\d*\.?\d+", raw)
    tr = float(numbers[0]) if numbers else 0.0
    te = float(numbers[1]) if len(numbers) > 1 else 0.0
    return {"tr_ms": tr, "te_ms": te}


def parse_duration_seconds(value: str) -> float:
    """Parse a Philips 'MM:SS.s' or 'HH:MM:SS' duration into seconds."""
    text = str(value).strip()
    if not text:
        return 0.0
    parts = text.split(":")
    try:
        numbers = [float(p) for p in parts]
    except ValueError:
        return 0.0
    seconds = 0.0
    for number in numbers:
        seconds = seconds * 60 + number
    return seconds


def format_duration(seconds: float) -> str:
    """Format seconds back into the Philips 'MM:SS.s' convention."""
    seconds = max(0.0, float(seconds))
    minutes = int(seconds // 60)
    remainder = seconds - minutes * 60
    if minutes >= 60:
        hours = minutes // 60
        minutes = minutes % 60
        return f"{hours:02d}:{minutes:02d}:{remainder:04.1f}"
    return f"{minutes:02d}:{remainder:04.1f}"


def headline_values(data: Dict[str, Any]) -> Dict[str, str]:
    tr_te = parse_tr_te(data)
    return {
        "duration": find_value(data, "Total scan duration"),
        "tr": f"{tr_te['tr_ms']:g}" if tr_te["tr_ms"] else "",
        "te": f"{tr_te['te_ms']:g}" if tr_te["te_ms"] else "",
        "voxel": find_value(data, "ACQ voxel MPS (mm)"),
        "slices": find_value(data, "slices"),
        "mbFactor": find_value(data, "MB Factor"),
        "senseP": find_value(data, "P reduction (AP)"),
        "flip": find_value(data, "Flip angle (deg)"),
        "dynScans": find_value(data, "dyn scans"),
        "dummyScans": find_value(data, "dummy scans"),
        "matrix": find_value(data, "Reconstruction matrix"),
        "technique": find_value(data, "technique"),
        "scanMode": find_value(data, "Scan mode"),
    }
