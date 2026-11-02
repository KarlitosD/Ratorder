# Ratorder

Grabador de pantalla local para navegadores Chromium. Graba pestañas, ventanas o la pantalla completa, mezcla micrófono y audio del sistema, y escribe el archivo progresivamente en el dispositivo. No hay cuentas ni servidor propio; el diagnóstico externo es opcional y está desactivado por defecto.

## Características

- Captura de pantalla, ventana o pestaña con `getDisplayMedia`.
- Micrófono y audio del sistema mezclados con Web Audio API.
- Codificación de video y audio con WebCodecs, a través de Mediabunny.
- MP4 fragmentado como formato principal y WebM como alternativa.
- Escritura incremental en OPFS desde un Web Worker.
- Pausa, reanudación y silencio de micrófono sin reiniciar el archivo.
- Biblioteca local con miniaturas, búsqueda, ordenación, reproducción, renombrado y borrado.
- Editor de video con línea de tiempo: recortar, dividir, eliminar segmentos, silenciar, cambiar la velocidad sin alterar el tono, combinar videos y superponer imágenes, formas y texto.
- Exportación de la edición como una copia nueva en OPFS; la grabación original se conserva.
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
npm test         # regresiones de audio, sincronización, modelo y exportación del editor
```

Las pruebas generan un tono conocido, lo graban con el controlador real y analizan
el archivo guardado para detectar cortes y distorsión en MP4/WebM, sin micrófono.
Reproducen variaciones controladas de los timestamps de captura para que la
regresión no dependa de la carga del equipo. No requieren permisos ni
usan tus grabaciones. Si Chromium no está en una ruta habitual de Linux, indicá
su ejecutable con `CHROMIUM_PATH=/ruta/al/navegador npm test`.

Las regresiones del editor generan grabaciones sintéticas, combinan dos videos,
aplican corte, silencio, velocidad, volumen y overlays, exportan MP4 y WebM, y verifican
duración, pistas, tono conservado, ganancia, píxeles compuestos y miniatura con
`ffprobe`/`ffmpeg`. También cubren el modelo de timeline, WSOLA, guardado explícito,
descarte de cambios, restablecimiento al original y restauración del proyecto guardado.

La prueba de sincronización genera destellos y pulsos sintéticos, graba con el
controlador real y mide desfase inicial y deriva en el archivo, incluyendo pausa
y carga simulada del hilo principal. El resultado es aproximado: está limitado
por los 30 fps del video, la detección de pulsos y el entorno de prueba; no
sustituye una captura real de pantalla y sonido del sistema.

Para inspeccionar un archivo guardado sin subirlo a ningún servicio:

```bash
node scripts/inspect-recording.mjs /ruta/a/grabacion.mp4
```

El informe usa `ffprobe` y muestra pistas, códecs, resolución, frecuencia,
canales, timestamps iniciales y cantidad de paquetes. No calcula frames perdidos
ni demuestra sincronización. Cuenta los paquetes leyendo el archivo completo,
por lo que puede tardar en grabaciones largas.

La evaluación experimental de AAC por WASM no modifica el encoder de la app.
Para ejecutarla localmente, instalá el paquete sin guardarlo en el proyecto y
habilitá la prueba opcional:

```bash
npm install --no-save --package-lock=false @mediabunny/aac-encoder@1.65.0
AAC_WASM_BENCH=1 node --test --test-name-pattern='experimental AAC' tests/recording-sync.test.mjs
```

Por defecto, la prueba usa un video sintético pequeño con pausas y presión
artificial del hilo principal; no valida grabaciones largas o de alta resolución.
El paquete se elimina al reinstalar las dependencias desde el lockfile.
Se pueden ampliar sus parámetros, por ejemplo:

```bash
AAC_WASM_BENCH=1 AAC_WASM_EVENTS=60 AAC_WASM_WIDTH=1920 AAC_WASM_HEIGHT=1080 \
  node --test --test-name-pattern='experimental AAC' tests/recording-sync.test.mjs
```

En Linux informa CPU y memoria aproximadas del árbol de procesos del navegador.
Incluyen video, renderizado y la carga artificial, no solo el encoder AAC; la
memoria suma RSS y puede contar páginas compartidas más de una vez. Los procesos
que nacen y terminan entre muestras pueden quedar excluidos. El video es un
canvas de colores planos, no representa la complejidad de un escritorio real.
Si el análisis de una prueba sintética falla, `AAC_KEEP_FAILED=1` conserva
temporalmente el archivo generado en `/tmp` e imprime su ruta para investigarlo.

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
    edit/
      project.json
      assets/        # videos e imágenes importados al editor
```

El proyecto de edición y los medios importados se guardan junto a la grabación. `project.json`
solo se escribe cuando pulsas **Guardar**; los cambios pendientes permanecen en memoria y
puedes descartarlos o restablecer el video original. Borrar la grabación elimina también su
proyecto y sus medios importados.

OPFS es almacenamiento del navegador, así que los archivos no aparecen en el explorador del sistema. Para obtener una copia utilízala acción **Exportar** del reproductor o **Exportar** del editor.

## Estructura del proyecto

```text
src/
  lib/
    components/       Interfaz de grabación, ajustes, biblioteca y editor
    editor/           Modelo de timeline, compositor, reproductor, audio y exportación
    media/            Selección compartida de códecs
    recording/        Controlador, mezcla de audio y presets
    storage/          OPFS, worker de escritura, biblioteca y proyectos de edición
    utils/            Formato de fechas, tamaños y duraciones
  App.svelte          Composición de la aplicación y estado global
  app.css             Tokens, componentes base y estilos globales
```

## Editor de video

El editor se abre desde **Biblioteca → Editar** o con **Editar video** al terminar una
grabación. Trabaja sobre el archivo ya guardado y no modifica la captura original.

- La línea de tiempo tiene una pista de video contigua, una pista de audio con forma de onda
  RMS y una pista de elementos. La onda permite localizar silencios y niveles bajos, y refleja
  el mute y el volumen del segmento. Se analiza en segundo plano al abrir o importar un video
  (máximo 2 a la vez); en archivos largos puede tardar unos segundos en aparecer. La segunda
  apertura reutiliza una caché local en OPFS y no vuelve a decodificar el audio completo.
- **Dividir** corta en el cabezal; los bordes de cada segmento permiten recortar.
- **Silenciar** aplica al segmento seleccionado. Para un rango arbitrario, se divide y se
  silencia el fragmento resultante.
- **Volumen** por segmento, de 0 a 150 %, independiente del silencio rápido. Se aplica al
  preview y a la exportación; subir el volumen de un segmento silenciado lo reactiva. Por
  encima del 100 % los picos de un audio ya fuerte pueden saturar.
- La velocidad de **preview** (0.25×, 0.5×, 1×, 2×) solo afecta a la reproducción del editor,
  no al proyecto ni a la exportación. Sirve para revisar cortes y elegir frames con calma.
  Algunos navegadores silencian el audio del elemento por debajo de 0.5×; imagen y reloj siguen
  funcionando con normalidad.
- **Velocidad** ofrece 0.5×, 0.75×, 1×, 1.25×, 1.5× y 2×. El preview usa `playbackRate` y
  la exportación usa WSOLA para conservar el tono de la voz.
- **Importar video** acepta MP4 y WebM decodificables y los añade al final de la timeline.
- **Añadir** permite texto, rectángulo, elipse, flecha e imágenes. Los elementos se pueden
  mover y redimensionar en el preview o ajustar con precisión en el inspector.
- **Guardar** es explícito: los cambios no se escriben en OPFS hasta que pulsas Guardar.
  Puedes descartar los cambios pendientes o **Restablecer original** para volver a la
  grabación completa sin cortes ni elementos. El proyecto guardado se restaura al reabrir.
- La barra de acciones está justo encima de la línea de tiempo. También puedes usar el
  **menú contextual** (clic derecho) sobre clips, elementos, la timeline o el preview.
- Atajos principales: espacio, `S` dividir, `M` silenciar, `Supr` eliminar,
  `Ctrl/⌘+Z`/`Ctrl/⌘+Mayús+Z`, `Ctrl/⌘+S` guardar, `Ctrl/⌘+E` exportar, `[`/`]`
  velocidad de preview, `?` ver todos.
- La exportación se ejecuta en un **worker** con `OffscreenCanvas`, WebCodecs y escritura
  directa a OPFS: la interfaz sigue respondiendo mientras se codifica. Requiere un navegador
  con esas APIs (Chromium de escritorio es el objetivo probado).
- Durante la edición en vivo el proyecto se publica como máximo una vez por frame y una
  interacción produce una sola entrada de deshacer. El preview limita su cadencia a los FPS
  del proyecto y mantiene como máximo 3 videos cargados con LRU. La biblioteca solo pide
  las miniaturas de las tarjetas visibles (más la seleccionada).

Quizá lo más importante a tener en cuenta: **la exportación vuelve a codificar todo el
video**. No hay smart-render ni copia sin recomprimir. Cada exportación crea una grabación
nueva `… (editada)` y conserva la original. La salida usa el contenedor de la grabación
fuente y una composición SDR/sRGB mediante Canvas 2D; una fuente HDR o de gama amplia puede
verse distinta. La duración se cuantiza a la grilla de FPS y el audio se recorta a esa
duración. WSOLA está pensado para voz entre 0.5× y 2×; la música con transitorios puede
presentar artefactos. No hay transiciones, keyframes, crop/rotación, picture-in-picture ni
subtítulos.

## Decisiones y límites actuales

- No hay backend propio, cuentas ni sincronización. La telemetría opcional usa un servicio externo si se configura y el usuario la habilita.
- La edición es no destructiva y se exporta como una copia nueva; no reemplaza el original.
- El proyecto de edición no se guarda automáticamente. Cerrar el editor con cambios pendientes pide confirmación; si sales sin guardar se conserva la última versión guardada.
- El plan de optimización del editor vive en [PLAN_OPTIMIZACION_EDITOR.md](PLAN_OPTIMIZACION_EDITOR.md).
- La exportación del editor re-codifica el proyecto completo. En grabaciones largas puede tardar y consumir CPU; se puede cancelar y no deja una copia parcial.
- La compatibilidad de un MP4 interrumpido depende de los fragmentos que hayan llegado a disco. Ratorder detecta y conserva la sesión, pero no promete reparar cualquier archivo dañado a nivel de contenedor.
- En navegadores sin codificador AAC se usa Opus dentro de MP4; algunos reproductores de escritorio podrían requerir códecs adicionales.
- El formato WebM se ofrece como alternativa, pero MP4 fragmentado es la opción recomendada para sesiones largas.
- La instalación como PWA requiere cargar la compilación de producción desde un contexto seguro.

## Privacidad

El procesamiento multimedia ocurre en el navegador y el resultado permanece en OPFS hasta que se exporta o elimina. Los videos e imágenes importados al editor también se copian a OPFS y nunca se suben a un servidor. Por defecto, Ratorder no envía eventos de diagnóstico. El envío a PostHog requiere que quien despliega la app lo configure y que cada usuario lo active explícitamente; se puede desactivar en cualquier momento desde **Grabar → Configuración → Opciones avanzadas → Diagnóstico**. La preferencia se guarda en el almacenamiento local del navegador.

## Diagnóstico de recursos
En **Grabar → Configuración → Opciones avanzadas → Diagnóstico** se puede ver y copiar un informe local de la sesión actual. Incluye la versión, contadores de workers de escritura, contextos y pistas de audio mezclado, URL temporales por uso y hasta diez sospechas de recursos no liberados en esta sesión. Las URL temporales pueden estar activas legítimamente mientras se muestra la biblioteca o un video, y durante un minuto tras una descarga. Los contadores no inspeccionan todos los recursos internos del navegador ni detectan todas las fugas. El informe no contiene nombres ni contenido de grabaciones.

Después de completar la limpieza de una grabación, si no comenzó otra y sigue habiendo un worker de escritura, contexto de audio o pista mezclada activo, se muestra una advertencia. Es una **sospecha**, no una confirmación de fuga. El informe también intenta obtener una muestra de memoria con `measureUserAgentSpecificMemory` si el navegador la ofrece y la página está aislada entre orígenes. Se guardan en memoria hasta diez muestras locales obtenidas al terminar la limpieza o solicitar el informe; permiten observar una tendencia pero no demuestran una fuga. `null` significa que no pudo medirse. Ratorder no configura por sí mismo el aislamiento COOP/COEP: depende del servidor de alojamiento y puede afectar a recursos externos.

### Configurar envío opcional a PostHog

1. Crear un proyecto gratuito en [PostHog](https://posthog.com/pricing) y obtener su **project token público**, no una clave personal.
2. Al compilar o iniciar Vite, definir `VITE_POSTHOG_TOKEN` y, opcionalmente, `VITE_POSTHOG_REGION=eu` (por defecto `us`). Por ejemplo, en un archivo `.env.local` no incluido en Git:

   ```text
   VITE_POSTHOG_TOKEN=phc_token_publico_del_proyecto
   VITE_POSTHOG_REGION=eu
   ```

3. Volver a compilar y desplegar. Sin token, el envío permanece deshabilitado. Cada usuario debe habilitarlo en **Grabar → Configuración → Opciones avanzadas → Diagnóstico**.
4. En PostHog, consultar el evento `diagnostic_resource_suspected` y configurar allí una alerta si se desea; Ratorder no configura alertas automáticamente. El límite y disponibilidad de las alertas dependen del plan de PostHog.

Como máximo se intenta enviar una sospecha por carga de página, solo si el consentimiento está activo en el momento de detectarla. El evento contiene el tipo de sospecha, la cantidad, la versión, la operación y un identificador aleatorio nuevo para ese evento; no contiene grabaciones, audio, miniaturas, títulos, URL de la página ni informe de memoria. No se utiliza el SDK de PostHog, autocaptura ni reproducción de sesión. La solicitud va directamente a PostHog, que puede recibir la dirección IP y datos habituales de conexión; revisá su política y la configuración de captura de IP del proyecto. No se reintenta si falla y desactivar el permiso impide envíos posteriores, pero no borra eventos ya recibidos. El token público queda incluido en la compilación y no debe tratarse como secreto.
