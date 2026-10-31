# Ratorder

Grabador de pantalla local para navegadores Chromium. Graba pestañas, ventanas o la pantalla completa, mezcla micrófono y audio del sistema, y escribe el archivo progresivamente en el dispositivo. No hay cuentas, servidores ni telemetría.

## Características

- Captura de pantalla, ventana o pestaña con `getDisplayMedia`.
- Micrófono y audio del sistema mezclados con Web Audio API.
- Codificación de video y audio con WebCodecs, a través de Mediabunny.
- MP4 fragmentado como formato principal y WebM como alternativa.
- Escritura incremental en OPFS desde un Web Worker.
- Pausa, reanudación y silencio de micrófono sin reiniciar el archivo.
- Biblioteca local con miniaturas, búsqueda, ordenación, reproducción, renombrado y borrado.
- Exportación con File System Access API por streaming, sin cargar el archivo en memoria.
- Detección de sesiones interrumpidas al volver a abrir la aplicación.
- PWA instalable y funcional sin conexión.
- Tema oscuro y claro, tipografía Inter y un sistema visual propio.

## Requisitos

- Chrome o Edge de escritorio actualizado (u otro Chromium moderno).
- `WebCodecs`, `FileSystemSyncAccessHandle` y OPFS disponibles.
- Contexto seguro: `https://` o `http://localhost`.
- Chromium puede no tener codificador AAC en algunos sistemas; en ese caso el audio se guarda en Opus dentro del MP4 y se avisa en la interfaz.

Firefox y Safari todavía no están contemplados como objetivos principales.

## Desarrollo

```bash
npm install
npm run dev
```

La aplicación estará disponible en la URL que indique Vite, normalmente `http://localhost:5173`.

Otros comandos:

```bash
npm run check    # comprobación de tipos y Svelte
npm run build    # compilación de producción + service worker
npm run preview  # sirve la compilación de producción
npm test         # regresión de audio con Chromium y ffmpeg instalados
```

Las pruebas generan un tono conocido, lo graban con el controlador real y analizan
el archivo guardado para detectar cortes y distorsión en MP4/WebM, sin micrófono.
Reproducen variaciones controladas de los timestamps de captura para que la
regresión no dependa de la carga del equipo. No requieren permisos ni
usan tus grabaciones. Si Chromium no está en una ruta habitual de Linux, indicá
su ejecutable con `CHROMIUM_PATH=/ruta/al/navegador npm test`.

La grabación necesita permisos de captura de pantalla y de micrófono. El navegador solo concede permisos en un contexto seguro.

## Arquitectura

```text
Media Capture API
       │
       ▼
MediaStream
       │
       ├── video ──► MediaStreamVideoTrackSource ──┐
       │                                           │
       └── audio ──► Web Audio (mezcla) ────────────┤
                                                   ▼
                                                Output (Mediabunny)
                                                   │
                                                   ▼
                                              StreamTarget
                                                   │
                                                   ▼
                                              Web Worker
                                                   │
                                                   ▼
                                       FileSystemSyncAccessHandle
                                                   │
                                                   ▼
                                                  OPFS
```

Puntos importantes:

- **El controlador no depende de Svelte.** `RecordingController` gestiona el ciclo de vida de la captura y publica un snapshot inmutable.
- **Máquina de estados explícita:** `idle → preparing → recording → paused → finalizing → completed`, con estados `error` y recuperación.
- **Backpressure real:** las escrituras del `StreamTarget` se confirman desde el worker antes de continuar.
- **Memoria acotada:** Mediabunny usa chunks pequeños de 64 KiB y OPFS recibe los datos de forma progresiva. La interfaz nunca conserva el archivo completo.
- **Persistencia de metadatos:** cada grabación tiene un `metadata.json` que se actualiza durante la sesión y se cierra al terminar.
- **Recuperación:** si la sesión no se cerró correctamente, el siguiente arranque la marca como interrumpida y conserva el archivo. Los datos ya escritos siguen siendo reproducibles y exportables.

## Estructura de almacenamiento

```text
recordings/
  <recording-id>/
    metadata.json
    video.mp4        # o video.webm
    thumbnail.webp
```

OPFS es almacenamiento del navegador, así que los archivos no aparecen en el explorador del sistema. Para obtener una copia utilízala acción **Exportar** del reproductor.

## Estructura del proyecto

```text
src/
  lib/
    components/       Interfaz de grabación, ajustes y biblioteca
    recording/        Controlador, mezcla de audio y presets
    storage/          OPFS, worker de escritura y biblioteca local
    utils/            Formato de fechas, tamaños y duraciones
  App.svelte          Composición de la aplicación y estado global
  app.css             Tokens, componentes base y estilos globales
```

## Decisiones y límites actuales

- No hay backend, cuentas ni sincronización.
- No se incluye edición de video todavía.
- La compatibilidad de un MP4 interrumpido depende de los fragmentos que hayan llegado a disco. Ratorder detecta y conserva la sesión, pero no promete reparar cualquier archivo dañado a nivel de contenedor.
- En navegadores sin codificador AAC se usa Opus dentro de MP4; algunos reproductores de escritorio podrían requerir códecs adicionales.
- El formato WebM se ofrece como alternativa, pero MP4 fragmentado es la opción recomendada para sesiones largas.
- La instalación como PWA requiere cargar la compilación de producción desde un contexto seguro.

## Privacidad

Ratorder no envía grabaciones, metadatos ni eventos a ningún servidor. Todo el procesamiento multimedia ocurre en el navegador y el resultado se queda en OPFS hasta que se exporta o se elimina.
