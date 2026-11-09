# Sapiens LM

Sapiens LM es una interfaz web local para conversar con modelos de lenguaje administrados por Ollama. El servidor Flask descubre los modelos disponibles en `models/`, ofrece respuestas en streaming y mantiene la memoria bajo control al cambiar de modelo.

## Requisitos

- Python 3.10 o posterior.
- [Ollama](https://ollama.com/) instalado y disponible en el sistema.
- Modelos de Ollama instalados en la carpeta `models/` de este proyecto.
- Paquetes de Python `Flask` y `requests`.

## Inicio rápido

Desde la carpeta del proyecto, instala las dependencias y arranca la aplicación:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install Flask requests
python app.py
```

Abre [http://127.0.0.1:7860](http://127.0.0.1:7860) en el navegador. También puedes usar el script de control:

```bash
./sapiens.sh start
./sapiens.sh status
./sapiens.sh logs
./sapiens.sh stop
```

El script usa `.venv/bin/python` si existe; de lo contrario, usa el Python disponible en el sistema.

## Modelos

La aplicación lee el almacén de modelos de Ollama ubicado en `models/`. Cada modelo debe tener su manifiesto y los blobs correspondientes para aparecer como disponible. El selector muestra los modelos conversacionales; los modelos de embeddings se identifican y se deshabilitan para el chat.

El proyecto incluye una carpeta `models/` para el almacén local. Los pesos pueden ocupar varios gigabytes y conviene administrarlos por separado del código fuente.

## Interfaz

El historial de conversaciones y sus títulos se guardan en el almacenamiento local del navegador. Para cambiar un título, selecciona el texto del título en el encabezado del chat o en el historial; escribe el nuevo nombre y pulsa Enter. Escape cancela la edición. El selector de la barra de mensaje permite cambiar entre los modelos conversacionales disponibles.

## Memoria

Sapiens consulta la memoria del sistema y los modelos cargados en Ollama. Al seleccionar otro modelo, descarga de memoria los anteriores para evitar que varios ocupen RAM a la vez. El botón **Liberar RAM** descarga el modelo cargado sin borrar sus archivos del disco.

## Configuración

La configuración se realiza con variables de entorno:

| Variable | Valor predeterminado | Uso |
| --- | --- | --- |
| `SAPIENS_HOST` | `127.0.0.1` | Dirección en la que escucha Flask. |
| `SAPIENS_PORT` | `7860` | Puerto de la interfaz web. |
| `SAPIENS_OLLAMA_PORT` | `11435` | Puerto del proceso Ollama privado de Sapiens. |
| `SAPIENS_KEEP_ALIVE` | `5m` | Tiempo que Ollama conserva el modelo cargado tras usarlo. |

Por ejemplo, para cambiar el puerto web:

```bash
SAPIENS_PORT=7861 python app.py
```

## API local

- `GET /health`: estado básico del servidor.
- `GET /api/status`: RAM del sistema y modelos cargados.
- `GET /api/models`: modelos locales disponibles y sus metadatos.
- `POST /api/select`: prepara el cambio de modelo y descarga los demás.
- `POST /api/unload`: descarga uno o todos los modelos de memoria.
- `POST /api/chat`: genera una respuesta en streaming para la conversación.

## Estructura del proyecto

```text
app.py                 Servidor Flask, API y gestión de Ollama
templates/index.html   Estructura de la interfaz
static/css/styles.css  Estilos
static/js/app.js       Historial local y experiencia de chat
models/                Almacén local de modelos Ollama
run/                   Logs y datos temporales de ejecución
sapiens.sh             Script para iniciar y administrar el servidor
```
