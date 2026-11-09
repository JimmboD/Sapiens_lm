#!/usr/bin/env bash
# Control de Sapiens: sapiens.sh {start|stop|restart|status|logs|open|install|uninstall}
# Funciona desde cualquier directorio y se puede enlazar (symlink) a otros lugares.
set -u

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
DIR="$(dirname "$SELF")"
RUN="$DIR/run"
PIDFILE="$RUN/sapiens.pid"
LOG="$RUN/sapiens.log"
PORT="${SAPIENS_PORT:-7860}"
HOST="${SAPIENS_HOST:-127.0.0.1}"
URL="http://127.0.0.1:$PORT"
PY="$DIR/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

mkdir -p "$RUN"

is_up() { curl -fs --max-time 1 "$URL/health" >/dev/null 2>&1; }
pid() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null && cat "$PIDFILE"; }

start() {
  if p=$(pid); then echo "Sapiens ya está en ejecución (pid $p) → $URL"; return 0; fi
  if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
    echo "El puerto $PORT está ocupado por otro proceso. Usa SAPIENS_PORT=<otro>." >&2; return 1
  fi
  cd "$DIR" || return 1
  SAPIENS_HOST="$HOST" SAPIENS_PORT="$PORT" setsid nohup "$PY" app.py >>"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  for _ in $(seq 1 40); do
    is_up && { echo "Sapiens iniciado → $URL (escuchando en $HOST)"; return 0; }
    pid >/dev/null || break
    sleep 0.25
  done
  echo "No arrancó. Últimas líneas del log:" >&2; tail -n 15 "$LOG" >&2
  rm -f "$PIDFILE"; return 1
}

stop() {
  if ! p=$(pid); then echo "Sapiens no está en ejecución."; rm -f "$PIDFILE"; return 0; fi
  kill -TERM "$p"   # app.py apaga también su Ollama privado
  for _ in $(seq 1 40); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done
  kill -0 "$p" 2>/dev/null && kill -KILL "$p"
  rm -f "$PIDFILE"
  echo "Sapiens detenido."
}

status() {
  if p=$(pid); then echo "activo (pid $p) → $URL"; is_up && echo "health: ok" || echo "health: sin respuesta"
  else echo "detenido"; return 3; fi
}

open_ui() { start || return 1; (xdg-open "$URL" >/dev/null 2>&1 &) || true; echo "$URL"; }

install() {
  local bin="$HOME/.local/bin" apps="$HOME/.local/share/applications"
  mkdir -p "$bin" "$apps"
  ln -sf "$SELF" "$bin/sapiens"
  cat >"$apps/sapiens.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Sapiens
Comment=Chat con modelos locales
Exec=$SELF open
Icon=utilities-terminal
Terminal=false
Categories=Utility;
Actions=Stop;

[Desktop Action Stop]
Name=Detener Sapiens
Exec=$SELF stop
EOF
  echo "Instalado: comando 'sapiens' en $bin y lanzador en $apps/sapiens.desktop"
  case ":$PATH:" in *":$bin:"*) ;; *) echo "Nota: añade $bin a tu PATH." ;; esac
}

uninstall() { rm -f "$HOME/.local/bin/sapiens" "$HOME/.local/share/applications/sapiens.desktop"; echo "Desinstalado."; }

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  logs) tail -n 50 -f "$LOG" ;;
  open) open_ui ;;
  install) install ;;
  uninstall) uninstall ;;
  *) echo "Uso: $(basename "$0") {start|stop|restart|status|logs|open|install|uninstall}"; exit 2 ;;
esac

