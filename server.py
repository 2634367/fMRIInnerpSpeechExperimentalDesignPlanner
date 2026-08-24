"""fMRI Experimental Design Planner - production HTTP server.

Serves the planner UI and a small JSON API over the scanner parameter cards,
saved designs and the XLSX report generator.  Run with::

    ./run.sh                      # waitress, 0.0.0.0:8760
    python server.py --port 9000  # explicit port
    python server.py --debug      # Flask reloader, development only
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import datetime
from typing import Any, Dict

from flask import Flask, Response, jsonify, request, send_from_directory

from planner.protocols import (
    PROTOCOL_ROLES,
    ProtocolError,
    ProtocolStore,
    find_value,
    headline_values,
    parse_duration_seconds,
    parse_tr_te,
)
from planner.report import build_workbook

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
PROTOCOL_DIR = os.environ.get(
    "PLANNER_PROTOCOL_DIR", os.path.join(BASE_DIR, "scanner-parameters")
)
PRESET_DIR = os.environ.get("PLANNER_PRESET_DIR", os.path.join(BASE_DIR, "presets"))
EXPORT_DIR = os.environ.get("PLANNER_EXPORT_DIR", os.path.join(BASE_DIR, "exports"))
MAX_PAYLOAD_BYTES = 32 * 1024 * 1024

os.makedirs(PRESET_DIR, exist_ok=True)
os.makedirs(EXPORT_DIR, exist_ok=True)

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["MAX_CONTENT_LENGTH"] = MAX_PAYLOAD_BYTES
app.json.sort_keys = False  # protocol sections must keep console order

store = ProtocolStore(PROTOCOL_DIR)

SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def _preset_path(name: str) -> str:
    clean = SAFE_NAME.sub("-", (name or "").strip())[:80] or "untitled"
    return os.path.join(PRESET_DIR, f"{clean}.json")


def _write_json(path: str, payload: Any) -> None:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _body() -> Dict[str, Any]:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ProtocolError("Request body must be a JSON object.")
    return data


# ------------------------------------------------------------------- pages


@app.route("/")
def index() -> Response:
    return send_from_directory(app.template_folder, "index.html")


@app.route("/favicon.ico")
def favicon() -> Response:
    return send_from_directory(app.static_folder, "wsu-mark.svg", mimetype="image/svg+xml")


# --------------------------------------------------------------------- api


@app.get("/api/health")
def health() -> Response:
    return jsonify(
        {
            "status": "ok",
            "protocolDir": PROTOCOL_DIR,
            "protocols": len(store.slugs()),
            "time": datetime.now().isoformat(timespec="seconds"),
        }
    )


@app.get("/api/bootstrap")
def bootstrap() -> Response:
    """Everything the client needs on first paint, in one round trip."""
    protocols = store.load_all()
    acquisition = {}
    for slug, data in protocols.items():
        if not isinstance(data, dict) or "_error" in data:
            continue
        tr_te = parse_tr_te(data)
        acquisition[slug] = {
            "trMs": tr_te["tr_ms"],
            "teMs": tr_te["te_ms"],
            "durationSeconds": parse_duration_seconds(
                find_value(data, "Total scan duration")
            ),
        }
    current = None
    current_path = _preset_path("current")
    if os.path.exists(current_path):
        try:
            with open(current_path, "r", encoding="utf-8") as handle:
                current = json.load(handle)
        except (OSError, json.JSONDecodeError):
            current = None
    return jsonify(
        {
            "manifest": store.manifest(),
            "protocols": protocols,
            "acquisition": acquisition,
            "roles": PROTOCOL_ROLES,
            "design": current,
            "presets": _preset_list(),
            "generated": datetime.now().isoformat(timespec="seconds"),
        }
    )


@app.get("/api/protocols")
def list_protocols() -> Response:
    return jsonify({"manifest": store.manifest()})


@app.get("/api/protocols/<slug>")
def get_protocol(slug: str) -> Response:
    try:
        return jsonify({"slug": slug, "data": store.load(slug)})
    except FileNotFoundError:
        return jsonify({"error": f"Unknown protocol {slug}"}), 404


@app.put("/api/protocols/<slug>")
def put_protocol(slug: str) -> Response:
    payload = _body()
    data = payload.get("data", payload)
    result = store.save(slug, data)
    result["headline"] = headline_values(store.load(slug))
    result["savedAt"] = datetime.now().isoformat(timespec="seconds")
    return jsonify(result)


@app.get("/api/protocols/<slug>/backups")
def list_backups(slug: str) -> Response:
    prefix = f"{slug}."
    entries = []
    for name in sorted(os.listdir(store.backup_dir), reverse=True):
        if name.startswith(prefix):
            path = os.path.join(store.backup_dir, name)
            entries.append(
                {
                    "file": name,
                    "size": os.path.getsize(path),
                    "modified": os.path.getmtime(path),
                }
            )
    return jsonify({"slug": slug, "backups": entries})


@app.post("/api/protocols/<slug>/restore")
def restore_backup(slug: str) -> Response:
    payload = _body()
    name = SAFE_NAME.sub("-", str(payload.get("file", "")))
    source = os.path.join(store.backup_dir, name)
    if not name.startswith(f"{slug}.") or not os.path.exists(source):
        return jsonify({"error": "Backup not found."}), 404
    with open(source, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    store.save(slug, data)
    return jsonify({"slug": slug, "restored": name, "data": data})


# ------------------------------------------------------------------ design


def _preset_list():
    entries = []
    for name in sorted(os.listdir(PRESET_DIR)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(PRESET_DIR, name)
        label = os.path.splitext(name)[0]
        title = label
        try:
            with open(path, "r", encoding="utf-8") as handle:
                blob = json.load(handle)
            title = (blob.get("meta") or {}).get("studyTitle") or label
        except (OSError, json.JSONDecodeError):
            pass
        entries.append(
            {
                "name": label,
                "title": title,
                "modified": os.path.getmtime(path),
            }
        )
    return entries


@app.get("/api/design")
def get_design() -> Response:
    name = request.args.get("name", "current")
    path = _preset_path(name)
    if not os.path.exists(path):
        return jsonify({"error": f"No saved design named {name}."}), 404
    with open(path, "r", encoding="utf-8") as handle:
        return jsonify({"name": name, "design": json.load(handle)})


@app.post("/api/design")
def post_design() -> Response:
    payload = _body()
    name = payload.get("name", "current")
    design = payload.get("design")
    if not isinstance(design, dict):
        return jsonify({"error": "design must be an object."}), 400
    _write_json(_preset_path(name), design)
    return jsonify(
        {
            "name": name,
            "savedAt": datetime.now().isoformat(timespec="seconds"),
            "presets": _preset_list(),
        }
    )


@app.delete("/api/design/<name>")
def delete_design(name: str) -> Response:
    path = _preset_path(name)
    if name == "current":
        return jsonify({"error": "The working design cannot be deleted."}), 400
    if os.path.exists(path):
        os.unlink(path)
    return jsonify({"deleted": name, "presets": _preset_list()})


# ------------------------------------------------------------------ export


@app.post("/api/export/xlsx")
def export_xlsx() -> Response:
    payload = _body()
    report = payload.get("report", payload)
    protocols = payload.get("protocols")
    if not isinstance(protocols, dict) or not protocols:
        protocols = store.load_all()
    report.setdefault("generated", datetime.now().strftime("%Y-%m-%d %H:%M"))
    blob = build_workbook(report, protocols)

    title = (report.get("meta") or {}).get("studyTitle") or "fMRI-Design"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"{SAFE_NAME.sub('-', title)[:60]}-{stamp}.xlsx"
    archive = os.path.join(EXPORT_DIR, filename)
    with open(archive, "wb") as handle:
        handle.write(blob)

    return Response(
        blob,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Planner-Archive": filename,
        },
    )


@app.post("/api/export/json")
def export_json() -> Response:
    payload = _body()
    blob = json.dumps(payload, indent=2).encode("utf-8")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return Response(
        blob,
        mimetype="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="fmri-design-{stamp}.json"'
        },
    )


@app.post("/api/apply-derived")
def apply_derived() -> Response:
    """Write solver-derived acquisition values back into a protocol card.

    Accepts ``{"slug": ..., "updates": {"dyn scans": 1900, ...}}`` and rewrites
    only those parameters, leaving every other row untouched.
    """
    payload = _body()
    slug = payload.get("slug", "")
    updates = payload.get("updates", {})
    if not isinstance(updates, dict) or not updates:
        return jsonify({"error": "updates must be a non-empty object."}), 400
    try:
        data = store.load(slug)
    except (FileNotFoundError, ProtocolError):
        return jsonify({"error": f"Unknown protocol {slug}"}), 404

    lowered = {str(k).strip().lower(): v for k, v in updates.items()}
    applied = {}
    for rows in data.values():
        if not isinstance(rows, list):
            continue
        for row in rows:
            key = str(row.get("parameter", "")).strip().lower()
            if key in lowered:
                row["value"] = str(lowered[key])
                applied[row["parameter"]] = row["value"]
    store.save(slug, data)
    return jsonify({"slug": slug, "applied": applied, "data": data})


@app.errorhandler(ProtocolError)
def handle_protocol_error(exc: ProtocolError) -> Response:
    return jsonify({"error": str(exc)}), 400


@app.errorhandler(404)
def handle_404(_exc) -> Response:
    if request.path.startswith("/api/"):
        return jsonify({"error": "Not found", "path": request.path}), 404
    return send_from_directory(app.template_folder, "index.html")


@app.after_request
def no_store(response: Response) -> Response:
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


# -------------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description="fMRI Experimental Design Planner")
    parser.add_argument("--host", default=os.environ.get("PLANNER_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("PLANNER_PORT", "8760"))
    )
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--debug", action="store_true", help="Flask reloader (development)")
    args = parser.parse_args()

    banner = (
        f"\n  fMRI Experimental Design Planner\n"
        f"  Wright State University\n"
        f"  ---------------------------------------------\n"
        f"  protocol cards : {PROTOCOL_DIR} ({len(store.slugs())} files)\n"
        f"  presets        : {PRESET_DIR}\n"
        f"  exports        : {EXPORT_DIR}\n"
        f"  listening on   : http://{args.host}:{args.port}\n"
    )
    print(banner, flush=True)

    if args.debug:
        app.run(host=args.host, port=args.port, debug=True)
        return 0

    try:
        from waitress import serve
    except ImportError:
        print(
            "  waitress not installed; falling back to the Flask server.\n"
            "  Install production dependencies with: pip install -r requirements.txt\n",
            file=sys.stderr,
            flush=True,
        )
        app.run(host=args.host, port=args.port, threaded=True)
        return 0

    serve(app, host=args.host, port=args.port, threads=args.threads, ident="fMRI-Planner")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
