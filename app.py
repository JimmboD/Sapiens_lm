"""Sapiens · Chat local sobre Ollama con gestión estricta de RAM.

Un único proceso Flask que:
  * Descubre modelos en ./models (formato Ollama).
  * Levanta y apaga su propio `ollama serve` privado en ./run.
  * Expone chat con streaming (NDJSON).
  * Control estricto de memoria: descarga modelos de RAM al cambiar de modelo o al solicitarlo.
  * Monitorea uso de RAM en tiempo real desde /proc/meminfo y Ollama /api/ps.
"""
import atexit
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from flask import Flask, Response, jsonify, render_template, request, stream_with_context

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
MANIFESTS_DIR = MODELS_DIR / "manifests" / "registry.ollama.ai" / "library"
METADATA_DIR = MODELS_DIR / "metadata"
RUN_DIR = BASE_DIR / "run"

HOST = os.environ.get("SAPIENS_HOST", "127.0.0.1")
PORT = int(os.environ.get("SAPIENS_PORT", "7860"))
OLLAMA_PORT = int(os.environ.get("SAPIENS_OLLAMA_PORT", "11435"))
OLLAMA_URL = f"http://127.0.0.1:{OLLAMA_PORT}"
KEEP_ALIVE = os.environ.get("SAPIENS_KEEP_ALIVE", "5m")

app = Flask(__name__)

# Perfiles informativos de los modelos conocidos
MODEL_PROFILES: Dict[str, Dict[str, Any]] = {
    "llama3.2": {
        "category": "General",
        "description": "Meta · Diálogo multilingüe y razonamiento rápido.",
        "icon": "message-square",
        "is_chat": True,
    },
    "qwen2.5": {
        "category": "General",
        "description": "Alibaba · Ágil, balance óptimo de velocidad y capacidad.",
        "icon": "zap",
        "is_chat": True,
    },
    "qwen2.5-coder": {
        "category": "Código",
        "description": "Alibaba · Especialista en programación, refactor y depuración.",
        "icon": "terminal",
        "is_chat": True,
    },
    "deepseek-r1": {
        "category": "Razonamiento",
        "description": "Razona paso a paso (Chain-of-Thought) antes de responder.",
        "icon": "brain",
        "is_chat": True,
    },
    "deepseek-coder": {
        "category": "Código",
        "description": "Generación y depuración avanzada de código.",
        "icon": "code",
        "is_chat": True,
    },
    "gemma2": {
        "category": "General",
        "description": "Google · Modelo compacto y eficiente para redacción.",
        "icon": "sparkles",
        "is_chat": True,
    },
    "medllama2": {
        "category": "Médico",
        "description": "Ajustado en dominio clínico y biomédico.",
        "icon": "activity",
        "is_chat": True,
    },
    "phi3": {
        "category": "Contexto largo",
        "description": "Microsoft · Compacto con amplia ventana de contexto.",
        "icon": "layers",
        "is_chat": True,
    },
    "nomic-embed-text": {
        "category": "Embeddings",
        "description": "Nomic · Vectorización semántica de texto (no conversacional).",
        "icon": "database",
        "is_chat": False,
    },
}


# --------------------------------------------------------------------------- #
# Memoria del sistema (/proc/meminfo)
# --------------------------------------------------------------------------- #
def get_system_ram() -> Dict[str, Any]:
    """Obtiene datos de RAM en MB para el monitoreo del servidor."""
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            lines = f.readlines()
        mem: Dict[str, int] = {}
        for line in lines:
            parts = line.split(":")
            if len(parts) == 2:
                mem[parts[0].strip()] = int(parts[1].strip().split()[0])
        total_mb = mem.get("MemTotal", 0) // 1024
        avail_mb = mem.get("MemAvailable", 0) // 1024
        used_mb = max(0, total_mb - avail_mb)
        percent = round((used_mb / total_mb) * 100, 1) if total_mb > 0 else 0
        return {
            "total_mb": total_mb,
            "avail_mb": avail_mb,
            "used_mb": used_mb,
            "percent": percent,
            "total_human": f"{total_mb / 1024:.1f} GB" if total_mb >= 1024 else f"{total_mb} MB",
            "avail_human": f"{avail_mb / 1024:.1f} GB" if avail_mb >= 1024 else f"{avail_mb} MB",
            "used_human": f"{used_mb / 1024:.1f} GB" if used_mb >= 1024 else f"{used_mb} MB",
        }
    except Exception:
        return {
            "total_mb": 3700,
            "avail_mb": 1800,
            "used_mb": 1900,
            "percent": 51.0,
            "total_human": "3.7 GB",
            "avail_human": "1.8 GB",
            "used_human": "1.9 GB",
        }


# --------------------------------------------------------------------------- #
# Descubrimiento de modelos en ./models
# --------------------------------------------------------------------------- #
def format_bytes(n: int) -> str:
    if n <= 0:
        return "0 MB"
    gb = n / (1024**3)
    if gb >= 1.0:
        return f"{gb:.2f} GB"
    return f"{n / (1024**2):.0f} MB"


def _blob_path(digest: str) -> Path:
    return MODELS_DIR / "blobs" / digest.replace(":", "-")


def _is_complete(manifest: Dict[str, Any]) -> bool:
    items = list(manifest.get("layers", []))
    if manifest.get("config"):
        items.append(manifest["config"])
    for item in items:
        p = _blob_path(item.get("digest", ""))
        try:
            if p.stat().st_size != int(item.get("size", -1)):
                return False
        except OSError:
            return False
    return True


def discover_local_models() -> List[Dict[str, Any]]:
    models: List[Dict[str, Any]] = []
    if not MANIFESTS_DIR.exists():
        return models

    for path in sorted(MANIFESTS_DIR.rglob("*")):
        if not path.is_file():
            continue
        parts = path.relative_to(MANIFESTS_DIR).parts
        if len(parts) < 2:
            continue
        family, tag = "/".join(parts[:-1]), parts[-1]
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        layers = manifest.get("layers", [])
        model_layer = next((l for l in layers if "model" in l.get("mediaType", "")), {})
        total = sum(int(l.get("size", 0)) for l in layers)

        kv: Dict[str, Any] = {}
        digest = model_layer.get("digest", "")
        meta = METADATA_DIR / f"{digest.replace(':', '-')}.json"
        if digest and meta.exists():
            try:
                kv = json.loads(meta.read_text(encoding="utf-8")).get("kv", {})
            except (OSError, json.JSONDecodeError):
                pass

        arch = kv.get("general.architecture", "unknown")
        ctx = kv.get(f"{arch}.context_length") or kv.get("llama.context_length") or 4096
        profile = MODEL_PROFILES.get(
            family,
            {
                "category": "General",
                "description": "Modelo de lenguaje local compatible con Ollama.",
                "icon": "cpu",
                "is_chat": ("embed" not in family and "embed" not in arch),
            },
        )

        is_chat = profile.get("is_chat", True)
        if "embed" in family or "embed" in arch:
            is_chat = False

        models.append(
            {
                "id": f"{family}:{tag}",
                "family": family,
                "tag": tag,
                "name": family,
                "category": profile.get("category", "General"),
                "description": profile.get("description", "Modelo local."),
                "icon": profile.get("icon", "cpu"),
                "size_human": format_bytes(total),
                "context_length": ctx,
                "available": _is_complete(manifest),
                "is_chat": is_chat,
            }
        )
    return models


# --------------------------------------------------------------------------- #
# Ollama privado (ciclo de vida ligado al de la app)
# --------------------------------------------------------------------------- #
_ollama_proc: Optional[subprocess.Popen] = None
_ollama_lock = threading.Lock()


def _ollama_alive() -> bool:
    try:
        return requests.get(f"{OLLAMA_URL}/api/version", timeout=1).ok
    except requests.RequestException:
        return False


def ensure_ollama(timeout: float = 20.0) -> bool:
    global _ollama_proc
    with _ollama_lock:
        if _ollama_alive():
            return True
        if _ollama_proc is None or _ollama_proc.poll() is not None:
            RUN_DIR.mkdir(exist_ok=True)
            env = os.environ.copy()
            (RUN_DIR / "ollama-home").mkdir(exist_ok=True)
            env.update(
                HOME=str(RUN_DIR / "ollama-home"),
                OLLAMA_HOST=f"127.0.0.1:{OLLAMA_PORT}",
                OLLAMA_MODELS=str(MODELS_DIR),
                OLLAMA_MAX_LOADED_MODELS="1",
                OLLAMA_NUM_PARALLEL="1",
                OLLAMA_KEEP_ALIVE=KEEP_ALIVE,
            )
            log = open(RUN_DIR / "ollama.log", "ab")
            try:
                _ollama_proc = subprocess.Popen(
                    ["ollama", "serve"],
                    env=env,
                    stdout=log,
                    stderr=log,
                    start_new_session=True,
                )
            except FileNotFoundError:
                return False

        deadline = time.time() + timeout
        while time.time() < deadline:
            if _ollama_alive():
                return True
            if _ollama_proc.poll() is not None:
                return False
            time.sleep(0.3)
        return False


def stop_ollama() -> None:
    global _ollama_proc
    if _ollama_proc and _ollama_proc.poll() is None:
        try:
            os.killpg(_ollama_proc.pid, signal.SIGTERM)
            _ollama_proc.wait(timeout=8)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(_ollama_proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    _ollama_proc = None


atexit.register(stop_ollama)


def _on_signal(signum, _frame):
    stop_ollama()
    sys.exit(0)


# --------------------------------------------------------------------------- #
# Gestión de RAM y descarga de modelos en Ollama
# --------------------------------------------------------------------------- #
def get_loaded_models() -> List[Dict[str, Any]]:
    """Consulta los modelos que están actualmente en RAM según Ollama /api/ps."""
    if not _ollama_alive():
        return []
    try:
        r = requests.get(f"{OLLAMA_URL}/api/ps", timeout=2)
        if r.ok:
            data = r.json().get("models", [])
            loaded: List[Dict[str, Any]] = []
            for item in data:
                name = item.get("name") or item.get("model")
                size = item.get("size", 0)
                loaded.append(
                    {
                        "name": name,
                        "size_bytes": size,
                        "size_human": format_bytes(size),
                        "expires_at": item.get("expires_at"),
                    }
                )
            return loaded
    except Exception:
        pass
    return []


def unload_models(target_to_keep: Optional[str] = None) -> List[str]:
    """
    Descarga inmediatamente de RAM cualquier modelo en memoria (keep_alive: 0).
    Si se especifica `target_to_keep`, descarga todos excepto ese modelo.
    """
    if not _ollama_alive():
        return []
    unloaded: List[str] = []
    try:
        r = requests.get(f"{OLLAMA_URL}/api/ps", timeout=2)
        if not r.ok:
            return []
        models_in_ram = r.json().get("models", [])
        for item in models_in_ram:
            name = item.get("name") or item.get("model")
            if not name:
                continue
            if target_to_keep and name == target_to_keep:
                continue
            try:
                # keep_alive: 0 en Ollama descarga de inmediato el modelo de la RAM/VRAM
                requests.post(
                    f"{OLLAMA_URL}/api/generate",
                    json={"model": name, "keep_alive": 0},
                    timeout=5,
                )
                unloaded.append(name)
            except Exception:
                pass
    except Exception:
        pass
    return unloaded


# --------------------------------------------------------------------------- #
# Rutas
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/health")
def health():
    """Para comprobación de vida desde páginas externas o scripts."""
    return jsonify(
        status="ok",
        service="sapiens",
        port=PORT,
        ollama=_ollama_alive(),
        ram=get_system_ram(),
    )


@app.route("/api/status")
def api_status():
    """Estado en tiempo real de RAM y modelos cargados."""
    return jsonify(
        status="ok",
        ollama=_ollama_alive(),
        ram=get_system_ram(),
        loaded_models=get_loaded_models(),
    )


@app.route("/api/models")
def api_models():
    models = discover_local_models()
    return jsonify(
        models=models,
        ollama=_ollama_alive(),
        ram=get_system_ram(),
        loaded_models=get_loaded_models(),
    )


@app.route("/api/unload", methods=["POST"])
def api_unload():
    """Descarga de RAM el modelo solicitado o todos los modelos cargados."""
    payload = request.get_json(silent=True) or {}
    model = payload.get("model")
    if model:
        try:
            requests.post(
                f"{OLLAMA_URL}/api/generate",
                json={"model": model, "keep_alive": 0},
                timeout=5,
            )
            unloaded = [model]
        except Exception:
            unloaded = []
    else:
        unloaded = unload_models(target_to_keep=None)

    return jsonify(
        status="ok",
        unloaded=unloaded,
        ram=get_system_ram(),
        loaded_models=get_loaded_models(),
    )


@app.route("/api/select", methods=["POST"])
def api_select():
    """
    Se invoca al cambiar de modelo en el frontend.
    Descarga de RAM inmediatamente cualquier otro modelo que estuviera cargado,
    garantizando que nunca convivan dos modelos en la limitada RAM del servidor.
    """
    payload = request.get_json(silent=True) or {}
    new_model = payload.get("model")
    unloaded = unload_models(target_to_keep=new_model)

    return jsonify(
        status="ok",
        selected=new_model,
        unloaded=unloaded,
        ram=get_system_ram(),
        loaded_models=get_loaded_models(),
    )


@app.route("/api/chat", methods=["POST"])
def api_chat():
    payload = request.get_json(silent=True) or {}
    model = payload.get("model")
    messages = payload.get("messages") or []
    opts = payload.get("options") or {}

    known = {m["id"]: m for m in discover_local_models()}
    if model not in known:
        return jsonify(error="Modelo no encontrado en ./models."), 404

    model_info = known[model]
    if not model_info["available"]:
        return jsonify(error="Los archivos de este modelo están incompletos."), 409

    if not model_info.get("is_chat", True):
        return jsonify(
            error=(
                f"El modelo '{model}' está clasificado como embeddings/vectorización "
                "y no admite diálogo conversacional. Por favor selecciona Qwen 2.5 o Llama 3.2."
            )
        ), 400

    if not messages:
        return jsonify(error="El mensaje no puede estar vacío."), 400

    if not ensure_ollama():
        return jsonify(error="No se pudo iniciar Ollama (revisa run/ollama.log)."), 503

    # Garantizar que NINGÚN otro modelo esté en RAM antes de inferir
    unload_models(target_to_keep=model)

    body = {
        "model": model,
        "messages": messages,
        "stream": True,
        "keep_alive": KEEP_ALIVE,
        "options": {
            "temperature": float(opts.get("temperature", 0.7)),
            "num_ctx": min(int(opts.get("num_ctx", 4096)), int(model_info["context_length"])),
        },
    }

    def generate():
        try:
            with requests.post(f"{OLLAMA_URL}/api/chat", json=body, stream=True, timeout=(5, 600)) as r:
                if not r.ok:
                    try:
                        msg = r.json().get("error", r.text)
                    except ValueError:
                        msg = r.text
                    yield json.dumps({"error": msg}) + "\n"
                    return
                for line in r.iter_lines():
                    if line:
                        yield line.decode("utf-8") + "\n"
        except requests.RequestException as e:
            yield json.dumps({"error": f"Fallo de conexión con Ollama: {e}"}) + "\n"

    return Response(
        stream_with_context(generate()),
        mimetype="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
