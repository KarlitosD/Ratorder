# Plan: optimización de rendimiento del editor

## Ubicación del entregable

Este plan queda como documento Markdown dentro del repositorio:

```text
PLAN_OPTIMIZACION_EDITOR.md
```

Este archivo es la única fuente de trabajo del plan y se enlazará desde `README.md`. La copia de revisión de `~/.commandcode/plans/optimizacion-rendimiento-editor.md` no se mantiene como una segunda versión activa.

## Objetivo

Atacar los seis frentes detectados en la auditoría estática:

1. Bucle de preview y trabajo repetido por frame.
2. Edición en vivo con demasiados snapshots, redraws y serialización.
3. WSOLA y allocaciones en el estiramiento temporal.
4. Waveform: decodificación completa, concurrente y sin caché.
5. Exportación: composición, audio y codificación en el hilo principal.
6. Escalado de timeline, biblioteca y medios cargados.

La exportación **pasa a un worker completo** con `OffscreenCanvas`, WebCodecs, Mediabunny y escritura OPFS. La composición, el audio, la codificación y el muxing salen del hilo principal. No se usará WASM en esta iteración y no se usará WebGPU. WASM queda como posible optimización futura de WSOLA si el perfil lo justifica.

## No objetivos

- No reescribir el pipeline de grabación: ya usa fuentes nativas/WebCodecs, Web Audio y un worker OPFS.
- No mover el preview a un worker: usa `HTMLVideoElement` y no se puede transferir directamente a un worker.
- No añadir efectos avanzados, transiciones, PiP, subtítulos ni cambios de modelo de edición.
- No cambiar el contrato de guardado explícito ni la semántica de la exportación.
- No introducir WebGPU/WGSL en el compositor actual; la composición es 2D simple.

## Presupuestos de aceptación

Se medirán antes (línea base) y después. Los números son objetivos de trabajo, no promesas absolutas; dependen del equipo.

| Escenario | Objetivo |
|---|---|
| Preview 1080p30 en pantalla de 120 Hz | Cadencia sostenida de hasta los fps del proyecto, no la frecuencia del monitor; invalidaciones explícitas aparte. Sin long tasks > 50 ms. |
| Arrastrar un overlay | Durante el arrastre, como máximo una actualización de proyecto y un redraw por frame; flush terminal aparte. p95 de frame < 16 ms en un proyecto típico. |
| Exportación 1080p/4K | La UI sigue respondiendo; sin long tasks > 50 ms en el hilo principal. El tiempo total no debe empeorar más de ~10 % respecto a la base. |
| Exportación de un único clip largo | Buffers de audio/video y paquetes pendientes acotados por la ventana de procesamiento, no por la duración del clip; sin crecimiento sostenido de memoria después del calentamiento. |
| Waveform al reabrir | Segunda apertura lee la caché; no vuelve a decodificar el audio completo. Concurrencia máxima: 2. |
| Timeline de 1 h con zoom alto | El DOM de ticks queda acotado por el viewport, no por la duración total. |
| Waveform de timeline con zoom alto | Rasterizar solo el viewport con margen, sin estirar una imagen de toda la timeline ni recorrer sus píxeles fuera de pantalla. |
| Biblioteca grande | Solo se piden miniaturas de tarjetas visibles (más la seleccionada). |
| Medios importados | El preview mantiene como máximo 3 videos cargados, sin expulsar el activo ni el preparado. |

Escenarios de referencia:

- 1080p30 de 10 minutos.
- 4K30 de 5 minutos.
- Proyecto con 10 clips, 5 overlays de texto/forma/imagen y una sección a 1.5×.
- Timeline de 1 hora con zoom manual alto.
- Biblioteca con 50–100 grabaciones.

Registrar navegador/versión, equipo, dimensiones reales del canvas de preview, códecs elegidos y fixtures usados. El preview actual limita el lado mayor a 1280 px: distinguir resolución del medio de resolución de composición. Repetir cada medición al menos tres veces y comparar medianas/p95; separar caché fría y caliente. No convertir variaciones normales entre equipos en fallos de CI.

---

## Fase 0: línea base y observabilidad

Medir antes de cambiar comportamiento. La prueba 0.1 es aislada y todavía no sustituye el camino de exportación de producción.

### Tareas

- Medir con Chrome Performance los escenarios de referencia.
- Anotar, para cada uno: tiempo de exportación, long tasks en el hilo principal, frame time del preview, tiempo de apertura del editor, tiempo de waveform y número de nodos de ticks.
- Comprobar el comportamiento actual de `CanvasRenderingContext2D` y de los workers con `performance.measure`/DevTools.
- Medir la exportación con y sin sección acelerada para separar el coste de WSOLA del de video.
- Registrar pico y evolución de memoria, número de medios abiertos y máximo adelanto entre timestamps de audio/video durante exportaciones largas, tanto de un clip como de varios.
- Contar composiciones (`renderFrame`), actualizaciones efectivas de proyecto y serializaciones de dirty por separado. `drawImage` no equivale a un frame: una composición puede dibujar video y varios overlays.

### Criterio de salida

Tener una tabla de base reproducible y confirmar que los cambios no degradan la salida funcional (duración, audio, overlays, códecs y miniatura).

### 0.1 Prueba temprana de viabilidad del worker

Antes de la migración completa, probar un export mínimo real desde worker con OffscreenCanvas, texto con Inter, audio planar y escritura OPFS; incluir cancelación y cierre del archivo. Ejecutarlo en Chromium objetivo y en build de producción/offline. Esta prueba valida soporte y empaquetado, no duplica el export completo ni elimina aún el camino actual. Resolver sus bloqueos antes de ampliar la fase 4.

---

## Fase 1: preview y edición en vivo

### 1.1 Caché de timeline y duración

Archivos:

- `src/lib/editor/model.ts`
- `src/lib/editor/player.ts`
- `src/lib/editor/controller.ts`
- `src/lib/components/editor/Timeline.svelte`
- `src/lib/components/editor/Inspector.svelte`

Cambios:

- Memoizar `layoutTimeline(project)` con una `WeakMap<EditorProject, TimelineClipView[]>`. El proyecto es inmutable en el modelo actual: cada edición crea otro objeto.
- Memoizar `projectDuration(project)` con otra `WeakMap`.
- Añadir una búsqueda de clip sobre las vistas cacheadas con búsqueda binaria por `start`; usarla en `findClipAt` y en el player.
- Evitar que `findClipAt` reconstruya el layout en cada frame.
- Reutilizar las vistas cacheadas en `#maybePrepareNext`, `#syncPlayback`, `redraw` y `#selectedClipId`.
- Las vistas cacheadas son de solo lectura; ningún consumidor debe ordenar o modificar el array compartido. Preservar la semántica de bordes de `findClipAt`: epsilon, tiempo negativo, corte exacto y fin del proyecto.
- En `#maybePrepareNext`, usar `current.index + 1` en vez de otro `findIndex` sobre las mismas vistas.

Precaución: si en el futuro se muta un proyecto in-place, estas cachés quedarían obsoletas. Mantener la regla actual de inmutabilidad y documentarla junto a las cachés.

### 1.2 Scheduler de redibujo del preview

Archivo: `src/lib/editor/player.ts`.

Problema actual: `requestAnimationFrame` ejecuta `redraw()` en cada refresco del monitor aunque el video tenga 30 fps o esté a 0.25×.

Cambios:

- Mantener un solo scheduler de composición en el player, con invalidación explícita. `setProject`, `setSelection` y la sincronización de medios no deben producir dibujos redundantes en el mismo frame.
- Para reproducción continua, usar deadlines o un acumulador que conserve el tiempo sobrante. La cadencia objetivo es `project.fps * Math.min(1, previewRate)` en tiempo de pared: limita a los fps del proyecto y reduce trabajo al reproducir lentamente.
- No reiniciar el presupuesto con `lastDraw = now` perdiendo el resto de cada intervalo ni exigir dos deltas desde el último dibujo efectivo: el jitter y las frecuencias no divisibles pueden reducir innecesariamente la cadencia.
- Si se pierden intervalos, dibujar el estado más reciente una vez, sin un bucle de frames atrasados; no dibujar si no cambió el estado relevante.
- Invalidar y asegurar un redraw oportuno en:
  - `setProject`
  - `seek`
  - `pause`
  - cambios de selección
  - cambio de tamaño del canvas
  - cambio de clip activo
  - inicio y fin de reproducción
- El presupuesto de reproducción no debe retrasar una edición/selección estando pausado ni la llegada del frame correcto al terminar un seek. Coalescer las invalidaciones coincidentes; una invalidación explícita puede superar la cadencia sostenida de reproducción, pero no debe duplicar composiciones del mismo estado.
- Mantener el reloj y la publicación de snapshots a 10 Hz; solo se limita el canvas.

No hace falta `requestVideoFrameCallback` en la primera pasada. Si el perfil muestra que el video entrega menos frames que el presupuesto, evaluarlo después; no añadir dos schedulers a la vez.

### 1.3 Evitar trabajo de audio/velocidad por frame

Archivo: `src/lib/editor/player.ts`.

- No llamar a `#applyClipAudio()` en cada frame: hacerlo solo cuando cambie el clip activo, el volumen o el mute.
- No asignar `element.playbackRate` en cada frame: hacerlo solo cuando cambie el clip o la velocidad de preview.
- Mantener la sincronización puntual de deriva.
- Aplicar la ganancia y el rate en `setProject`, `#syncPlayback`, `#promoteContinuous` y al cambiar la velocidad de preview.
- Al editar únicamente overlays, no invalidar el clip preparado ni reanclar el reloj: `setProject()` hoy borra la preparación incluso si el montaje no cambió. Conservarla cuando los clips/medios implicados sigan siendo válidos; invalidarla si cambia su trim, orden, velocidad, medio o disponibilidad. No introducir un sistema general de diff de proyectos.

### 1.4 Compositor: duración y texto

Archivo: `src/lib/editor/compositor.ts`.

- Añadir `duration?: number` a `RenderFrameOptions`; el player y el export pasan la duración cacheada. Se evita `projectDuration()` por frame.
- Añadir una caché opcional de wrapping de texto por overlay:
  - Clave: id + texto + maxWidth y fontSize efectivos en píxeles + fontWeight + identidad/estado de la fuente.
  - Valor: líneas calculadas.
  - Usarla en preview y export.
- Acotar la caché a la última entrada por overlay y contexto de render, eliminar overlays retirados e invalidar al cargar/cambiar fuentes. No acumular una entrada por cada tamaño intermedio de un drag; preview, export y miniatura pueden tener escalas distintas.
- No cachear la selección ni el canvas; solo el cálculo tipográfico.
- Mantener `imageSmoothingQuality` actual salvo que el perfil demuestre coste; no cambiarlo a ciegas.

### 1.5 Coalescer la edición en vivo

Archivos:

- `src/lib/editor/controller.ts`
- `src/lib/components/editor/Timeline.svelte`
- `src/lib/components/editor/PreviewStage.svelte`
- `src/lib/components/editor/Inspector.svelte`

Cambios:

- Mantener un proyecto pendiente en el controller y publicar/sincronizar con el player como máximo una actualización por `requestAnimationFrame` durante una interacción.
- Todas las operaciones live calculan sobre el proyecto efectivo más reciente (`pendiente ?? publicado`). `updateOverlayLive`, volumen y trim incremental deben usarlo; dos parches distintos antes del flush no pueden sobrescribirse. Los drags que envían un proyecto completo desde su estado inicial deben conservar su cálculo absoluto, no acumular el delta en cada evento.
- `updateProjectLive()` reemplaza el pendiente por ese estado completo actualizado y programa un único flush. No crear snapshots de historial por cada pointermove.
- Hacer flush antes de **leer y calcular** `commitInteraction()`, acciones discretas, undo/redo, guardar, exportar y reset. Hacerlo solamente dentro de `#apply(next)` llega tarde si `next` ya se calculó sobre un estado viejo. Una interacción produce una sola entrada de undo.
- Si se pide undo durante una interacción aún no comprometida, cerrarla como una única entrada antes de retroceder, de modo que redo pueda restaurar su estado final. No generar entradas adicionales por los flushes intermedios.
- Descartar cambios cancela el pendiente y restaura la baseline, sin publicarlo primero. Al cambiar de proyecto o hacer dispose, cancelar el rAF y descartar referencias pendientes para que no reaparezcan después; dispose nunca guarda ni hace commit implícito.
- Emitir un snapshot coherente por flush con proyecto, duración, selección, dirty e historial. Evitar las emisiones/redraws duplicados de `#apply() → setProject() → setSelection()` y sus callbacks. Las acciones terminales pueden forzar un flush fuera del rAF para no perder el último evento.
- Revisar `#updateDirty()`:
  - En la primera iteración, calcular la firma exacta una vez por flush, no por cada pointermove.
  - Cachear la firma de la baseline al inicializar/guardar/restaurarla: hoy se vuelve a serializar el mismo proyecto guardado en cada `#updateDirty()`.
  - Si el coste sigue apareciendo, usar `dirty = true` optimista durante la interacción y recalcular la firma exacta en el commit.
- Mantener la semántica: el proyecto no se guarda hasta Guardar; el header debe mostrar “Cambios sin guardar” cuando corresponda.
- Los guards de salida/`beforeunload` también deben considerar una edición pendiente aún no publicada; no depender de que llegue el próximo rAF.

### 1.6 Tests de fase

- Añadir test puro para la caché de layout/duración y búsqueda binaria.
- Testear el presupuesto de dibujo con reloj/rAF controlados a 60/120/144 Hz, con jitter, saltos largos y velocidades 0.25×/1×/2×. Comprobar cadencia y ausencia de recuperación en ráfaga, no solo un límite superior.
- Test de navegador:
  - reproducir a 30 fps y contar composiciones, no llamadas individuales a `drawImage`; no debe acercarse a 120 Hz.
  - arrastrar un overlay y comprobar que el proyecto no se actualiza más de una vez por frame.
  - aplicar dos parches distintos antes de un flush y comprobar que ambos sobreviven;
  - `pointerup → undo/redo`, guardar/exportar antes del rAF, descartar y dispose con un pendiente;
  - comprobar una sola composición al cambiar proyecto y selección estando pausado, y que editar un overlay no pierda la preparación del próximo clip.
- Regresión visual/funcional: preview, seek, corte entre clips, volumen, mute y selección.

---

## Fase 2: WSOLA sin WASM

Archivo principal: `src/lib/editor/time-stretch.ts`.

### Optimizaciones

1. **Canal mid cacheado**
   - `#midChannel()` se llama hoy desde `#findCandidate()` y crea un `Float32Array` nuevo por bloque.
   - Crear un buffer reutilizable y recalcularlo solo cuando cambie el buffer de entrada (push, trim o cambio de longitud), no por candidato.

2. **Energía de plantilla precalculada**
   - `#correlation()` recalcula la energía de la plantilla en cada candidato, pero la plantilla es la misma durante toda la búsqueda.
   - Calcularla una vez por `#findCandidate` y pasarla a la correlación.
   - Reutilizar la energía de la fuente por candidato, sin recalcular la plantilla.

3. **Búsqueda más barata**
   - Calcular `#effectiveSearch()` una vez por búsqueda, no dentro de `evaluate`.
   - Mantener la búsqueda coarse-to-fine actual.
   - Evitar closures y llamadas repetidas dentro del bucle de candidatos.
   - Considerar reducir el rango de búsqueda solo si los tests de calidad y duración siguen pasando.

4. **Menos allocaciones**
   - Reutilizar buffers de salida cuando sea posible.
   - Evitar `#accum.map(...).slice(...)` por bloque si se puede escribir en una cola de chunks estable.
   - Revisar `#outputChunks.shift()`; para una cola pequeña no es urgente, pero puede sustituirse por un índice de lectura.

### Tests

- Mantener las pruebas existentes de pitch y duración a 0.5×, 1.5× y 2×.
- Añadir una señal periódica y otra con silencios para validar que no se repite una ventana ni se altera la duración.
- Exportar un proyecto con una sección acelerada y verificar tono, RMS y duración final.

### Criterio de salida

Mismo audio, misma duración y menos trabajo por bloque. No introducir WASM en esta fase.

---

## Fase 3: caché y concurrencia de waveform

### 3.1 Formato de caché

Archivos:

- `src/lib/storage/recording-store.ts`
- Nuevo `src/lib/editor/waveform-cache.ts`
- `src/lib/editor/controller.ts`
- `src/lib/editor/types.ts` si hace falta un tipo compartido.

Ubicación:

```text
recordings/<recordingId>/edit/waveforms/<safeMediaId>.bin
```

`source` para la grabación original; el id del asset para los importados.

Formato binario:

- magic `RTWF`
- versión
- `mediaSize` (tamaño del archivo original)
- `duration`
- `binCount`
- `Float32Array` de bins RMS

Validaciones:

- Versión conocida.
- Tamaño del archivo actual coincide.
- Duración finita y compatible con la metadata validada, con tolerancia explícita; `binCount` entero dentro del límite del algoritmo actual.
- Longitud exacta del payload y bins finitos/no negativos. Rechazar cabeceras truncadas antes de reservar memoria según sus campos.
- Si falla cualquier cosa, ignorar la caché y recalcular.

La versión incluye la definición del análisis (RMS, densidad/stride y origen temporal de los bins); cambiarla cuando cambie el algoritmo. Tamaño e id son una identidad práctica para medios inmutables administrados por el store, no una prueba de integridad del archivo original. Invalidar al reemplazar el medio; no añadir un hash completo que obligue a leer todo el archivo en cada apertura.

La caché es opcional: si OPFS falla o no hay permisos, el editor sigue funcionando sin ella.

### 3.2 Controller y cola

- `#startWaveform` primero intenta caché; si hay hit, publica `loading:false` sin decodificar.
- Si no hay hit, encola el trabajo.
- Cola con máximo 2 decodificaciones concurrentes.
- Prioridad: `source` primero; después assets en orden de proyecto.
- `AbortController` existente cancela la cola y el cómputo al cerrar el editor.
- Si el signal ya está abortado, no iniciar lectura/análisis. No publicar resultados de una generación anterior ni ocupar un slot con un trabajo cancelado.
- Al guardar una waveform calculada, escribir la caché en segundo plano; un fallo de escritura no afecta a la edición.
- Al eliminar un asset importado no guardado, borrar también su caché si existe.
- Coordinar la eliminación con escrituras pendientes para que una tarea tardía no recree la caché o la carpeta de una grabación eliminada. Nunca persistir un resultado parcial/abortado como válido.

### 3.3 Tests

- Test puro de encode/decode del formato.
- Test de invalidación por versión, tamaño o duración.
- Test de navegador:
  - abrir un proyecto con audio;
  - esperar a que termine la waveform;
  - comprobar que existe la caché;
  - reabrir y comprobar que la waveform aparece sin una segunda decodificación completa (instrumentar el contador de análisis).
- Verificar que una caché corrupta no rompe la apertura.
- Verificar el límite de concurrencia, signal ya abortado y eliminación de un asset mientras se analiza/escribe su caché.

---

## Fase 4: exportación completa en worker

Esta es la fase de mayor alcance. El worker es responsable de composición, audio, codificación, muxing, miniatura y escritura del archivo. El hilo principal solo prepara archivos/metadatos, mantiene el lock, recibe progreso y guarda la metadata final.

### 4.1 Refactor del audio a frames planares

Archivos:

- Extraer de `src/lib/editor/audio.ts` un núcleo puro, por ejemplo `src/lib/editor/audio-frames.ts`.
- Mantener `src/lib/editor/time-stretch.ts` compartido.
- Añadir adaptadores de lectura:
  - Main/DOM: conservar `AudioBufferSink` solo en los consumidores que lo necesiten, como waveform; no mantener otro export completo por compatibilidad.
  - Worker: `AudioSampleSink` de Mediabunny, sin `AudioBuffer`.

Modelo intermedio:

```ts
interface DecodedAudioFrame {
  channels: Float32Array[]
  sampleRate: number
  timestamp: number
}

interface AudioFrameChunk {
  channels: Float32Array[]
  frames: number
}
```

El núcleo debe conservar:

- silencio,
- resampling lineal,
- volumen de 0 a 1.5,
- WSOLA optimizado,
- concatenación exacta y duración esperada.

En el worker, convertir cada `AudioFrameChunk` en `AudioSample` con `format: 'f32-planar'`, `sampleRate`, `numberOfChannels` y `timestamp` en **segundos**. El constructor recibe un único `BufferSource`: empaquetar los canales consecutivamente en un buffer de `frames * numberOfChannels` floats, no pasar `Float32Array[]` como `data`. El timestamp se calcula desde un cursor entero global de frames emitidos dividido por el sample rate; no sumar duraciones flotantes ni reiniciarlo por clip.

Leer `AudioSampleSink.samples()` con `copyTo(..., { format: 'f32-planar', planeIndex })` por canal. Cerrar los samples de entrada y salida en `finally`, también al cancelar o cortar un iterador. No reutilizar/escribir sus buffers mientras todavía pertenezcan a un sample en uso; primero priorizar ownership claro, luego medir si un pool aporta valor.

Mantener los límites de cada clip redondeando sus posiciones globales (`round(view.start/end * sampleRate)`), como hace el export actual; no redondear cada duración por separado. Conservar offsets de origen de video/audio y probar fronteras de chunks, mono/estéreo y entrada a 44.1/48 kHz.

**Optimización adicional de memoria:** hoy `audio.ts` crea arrays del tamaño de todo un hueco o cola silenciosa y `pushFrames()` puede materializar todos los chunks antes de devolverlos. Generar/rellenar silencio en bloques acotados y emitirlos incrementalmente, también al alimentar WSOLA; no reservar memoria proporcional al hueco. Comprobar cancelación y drenar salida entre bloques. No cambiar el algoritmo de resampling en esta iteración.

No usar `AudioBuffer`, `AudioContext` ni `AudioBufferSource` en el worker.

### 4.2 Protocolo y orquestador principal

Archivos nuevos:

- `src/lib/editor/export-protocol.ts`
- `src/lib/editor/export.worker.ts`

Archivo modificado:

- `src/lib/editor/export.ts` (queda como orquestador del hilo principal).

Mensajes:

```ts
type ExportStartMessage = {
  type: 'start'
  project: EditorProject
  sourceFile: File
  assetFiles: Record<string, File>
  recordingId: string
  extension: 'mp4' | 'webm'
  videoCodec: VideoCodec
  audioCodec: AudioCodec | null
  videoBitrate: number
  audioBitrate: number
}

type ExportMainMessage =
  | ExportStartMessage
  | { type: 'cancel' }

type ExportWorkerMessage =
  | { type: 'ready' }
  | { type: 'progress'; progress: number; message: string }
  | { type: 'done'; result: {
      size: number
      mimeType: string | null
      thumbnail: Blob | null
    } }
  | { type: 'error'; error: string }
  | { type: 'canceled' }
```

Flujo principal:

1. Validar proyecto y duración.
2. Elegir preset, bitrate y códecs con las APIs actuales.
3. Recolectar los archivos necesarios, sin copiar su contenido a `ArrayBuffer` en main:
   - `sourceFile`;
   - videos referenciados por clips;
   - imágenes referenciadas por overlays.
4. Crear `new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' })`, registrar listeners de mensajes/errores y esperar `ready` con timeout de arranque. El worker valida las APIs requeridas antes de confirmar; un fallo de soporte no crea una grabación incompleta.
5. Crear id y metadata `status: 'recording'` y `editedFrom`; adquirir el lock antes de publicar la grabación mediante el store.
6. Crear la carpeta/metadata y enviar `start`. Un worker procesa una sola exportación; no hace falta multiplexar jobs.
7. Reenviar progreso monótono al controller.
8. Al recibir `done`, que confirma que los recursos del worker ya están cerrados:
   - comprobar cancelación antes de iniciar la persistencia final;
   - guardar miniatura como best-effort, sin convertir su fallo en pérdida del export, igual que hoy;
   - actualizar metadata a `completed` con tamaño, MIME, códecs;
   - liberar lock y resolver.
9. En error/cancelación, esperar el cierre cooperativo o terminar el worker al vencer el timeout, borrar la grabación incompleta y liberar lock en `finally`.
10. En todos los caminos, terminar el worker, quitar listeners y cancelar timers. Una promesa terminal se resuelve/rechaza una sola vez; mensajes tardíos no modifican el resultado.

Revisar `signal.aborted` antes y después de las esperas de archivos, codecs, arranque y creación de la grabación, no solo en el bucle de frames. Serializar el cierre de cancelación con `done`: una vez iniciada la persistencia final, completarla o gestionar su error sin lanzar otro cleanup concurrente; una cancelación tardía no borra una grabación ya completada.

El lock y la carpeta de grabación se crean en el hilo principal antes de que el worker abra el archivo de salida. El worker nunca usa `RecordingStore`.

### 4.3 Worker: entrada y recursos

Archivo: `src/lib/editor/export.worker.ts`.

- `/// <reference lib="webworker" />`.
- Recibe el mensaje `start`.
- Revalidar la configuración de codificación en el entorno del worker; el soporte consultado en main no reemplaza esa comprobación ni el manejo de errores del encoder.
- Abre los `File` con `BlobSource`/`Input` mediante el `probeMedia` actual.
- Decodifica imágenes de overlays con `createImageBitmap(file)` en el worker.
- Carga las fuentes Inter en `self.fonts`:
  - `FontFace('Inter Variable', url(...))`;
  - weight `100 900`;
  - mismos subconjuntos y `unicodeRange` que el CSS Inter actual; incluir Latin y Latin Extended sin perder los otros alfabetos que ya soporta el preview;
  - URLs de assets resueltas por Vite (`?url` o mecanismo equivalente), no rutas a `node_modules` en runtime;
  - `await face.load()` para las caras requeridas;
  - `self.fonts.add(face)`;
  - `await self.fonts.ready`.
- Si la carga de fuentes falla, continuar con la fuente del sistema y registrar el aviso; no bloquear toda la exportación por una fuente.
- `CanvasSink` devuelve `OffscreenCanvas` fuera del DOM; `renderFrame` ya acepta su contexto 2D.
- Crear `OffscreenCanvas(project.width, project.height)` y contexto 2D con `alpha:false`.
- Generar la miniatura con `OffscreenCanvas.convertToBlob({ type: 'image/webp', quality: 0.82 })` y devolver el Blob.
- Cerrar todos los `Input`, `ImageBitmap` y samples en `finally`.
- Abrir/decodear solo medios realmente usados y mantener imágenes compartidas por asset, no por overlay. Los contadores de recursos del main y del worker son independientes: instrumentar el ciclo de vida del worker/handle y comprobar cierre real, no asumir que un contador cero en main prueba ausencia de fugas en worker.

### 4.4 Worker: salida OPFS directa

Archivo nuevo: `src/lib/editor/export-opfs.ts` (solo worker).

- Abrir `recordings/<recordingId>/video.<extension>` con `FileSystemSyncAccessHandle`, como el writer de grabación.
- `truncate(0)` al abrir.
- Implementar el `WritableStream<StreamTargetChunk>`:
  - escribir `chunk.data` en `chunk.position`;
  - comprobar escritura completa y actualizar tamaño con `max(size, position + bytesWritten)`, no sumando bytes: el muxer puede reescribir posiciones anteriores;
  - flush periódico/flush final;
  - cerrar el handle en `close`/`abort`.
- `StreamTarget` con `chunked: true`, `chunkSize: 64 * 1024`.
- Mantener el archivo parcial si hay error; el main decide borrar la grabación.
- Cierre/abort idempotentes; liberar el handle incluso si el flush falla. No confirmar `done` antes del flush/cierre final.
- No reutilizar `OpfsStreamWriter`: crea un worker anidado innecesario y el export worker ya está fuera del hilo principal.

### 4.5 Worker: video y audio

Pipeline:

1. Abrir medios y assets; crear `CanvasSink` por medio y `AudioSampleSink` para audio.
2. Crear una sola `VideoSampleSource` y, si corresponde, una sola `AudioSampleSource` por exportación. Añadir sus pistas al `Output` **antes** de `output.start()`; reutilizarlas durante todos los clips. No crear fuentes/pistas por segmento.
3. Calcular `layoutTimeline(project)`, duración, total de frames de video y total de frames de audio una vez.
4. Para cada clip:
   - obtener sus rangos de frames desde las posiciones globales redondeadas, conservando el cursor continuo del export actual;
   - generar timestamps de entrada monótonos con un iterable/generador, no un array completo proporcional a la duración del clip; `canvasesAtTimestamps` acepta iterables;
   - obtener canvas de `CanvasSink.canvasesAtTimestamps`;
   - `renderFrame` en OffscreenCanvas, con duración y caché de texto;
   - `new VideoSample(offscreenCanvas, { timestamp, duration })`;
   - `await videoSource.add(sample)`;
   - intercalar chunks de audio y video según sus timestamps globales, manteniendo un adelanto acotado (inicialmente alrededor de 1 segundo, como el export actual); no codificar todo el video del clip y luego su audio;
   - añadir el audio con el núcleo compartido y timestamp continuo, incluidos silencio y último chunk parcial;
   - respetar `await source.add(sample)` en ambas pistas; cerrar cada sample en `finally` y no crear colas paralelas sin límite;
   - reportar progreso con throttle (por ejemplo ≥120 ms);
   - comprobar cancelación en cada frame y en cada chunk.
5. Generar la miniatura usando un frame de `CanvasSink`, con caché tipográfica separada por escala.
6. `await output.finalize()` y obtener MIME después de alimentar las pistas, no antes de inicializar los encoders.
7. Completar flush/cierre del writer y cleanup de recursos; después enviar `done` con `size`, `mimeType` y miniatura.

El intercalado es una garantía de memoria, no solo de sincronía: el muxer debe esperar paquetes de ambas pistas y puede retener el video si el audio no avanza. Medir el caso de un único clip largo; fragmentar MP4 o usar `StreamTarget` no elimina por sí solo ese buffering. Referencias: [escritura e intercalado](https://mediabunny.dev/guide/writing-media-files#packet-buffering), [samples de audio](https://mediabunny.dev/guide/packets-and-samples) y contrato de la versión instalada en `node_modules/mediabunny/src`.

No usar `document`, `document.fonts`, `HTMLCanvasElement`, `AudioBuffer` ni `AudioContext` en el worker.

### 4.6 Cancelación y errores

- `AbortSignal` del main envía `cancel`.
- El worker comprueba la bandera durante apertura, bucles de video/audio, miniatura y finalización. Ante cancelación, llama a `output.cancel()` y al abort del writer; `canceled` se envía después del cleanup, no al recibir el pedido.
- Ceder periódicamente al event loop del worker durante trabajo CPU prolongado para recibir `cancel`; `await` sobre promesas ya resueltas no garantiza procesar un evento `message`. La granularidad debe incluir WSOLA/relleno de silencio, no solo cada frame de video.
- El main tiene un timeout de terminación; si el worker no responde, `worker.terminate()`.
- El main maneja `worker.onerror` y `messageerror` además de mensajes `{ type: 'error' }`: errores de carga/import del módulo pueden ocurrir antes de que el worker registre su protocolo.
- En el camino cooperativo, serializar el error después del cleanup. Ante fallo fatal o timeout, terminar el worker antes de borrar el archivo y no ignorar silenciosamente un fallo de borrado/lock; mantener un estado recuperable y avisar si queda un parcial.
- Si se pudo crear la grabación pero no arrancar la escritura, eliminarla con el mismo cleanup; los fallos de borrado siguen siendo visibles, no un éxito silencioso.
- Si el fallo es de soporte de APIs, mensaje claro en español.

### 4.7 Código legacy

Eliminar del hilo principal:

- `AudioBufferSource`;
- composición con `HTMLCanvasElement`;
- `document.fonts.ready`;
- `canvasToBlob`;
- `openMedia` en main;
- el bucle de decode/encode.

`getImages` deja de ser dependencia del export; el worker decodifica imágenes desde archivos. Actualizar `ExportDependencies` y los tests que construyen dependencias.

No se mantiene una segunda implementación completa en main. El worker es el camino único; si faltan APIs requeridas, se devuelve un error accionable.

### 4.8 Tests

- Adaptar `tests/editor-export.test.mjs` a las nuevas dependencias.
- MP4:
  - duración;
  - codecs;
  - audio con tono, mute, volumen 0.5 y 1.5;
  - overlay de forma;
  - overlay de imagen;
  - texto.
- WebM:
  - VP9/Opus;
  - texto con fuente cargada en worker;
  - duración.
- Miniatura generada desde el worker.
- Progreso monótono.
- Un único clip largo y varios clips: timestamps continuos, desfase A/V acotado y memoria sin crecimiento proporcional al metraje; probar también sin pista de audio, mute completo y grandes huecos/colas de silencio.
- Audio mono/estéreo a 44.1/48 kHz, cambios de velocidad y fronteras de chunks; validar canal izquierdo/derecho, tono, RMS y duración, no solo que exista una pista.
- Texto con acentos y alfabetos cubiertos por el CSS actual; comparar fuente/wrapping de preview, export y miniatura, además de verificar que se dibujó algún pixel de texto.
- Cancelación:
  - signal ya abortado y abort durante preparación, audio/WSOLA, video y finalización;
  - comprobar que no queda grabación completada;
  - comprobar que el lock y el handle se liberan, intentando reabrir/borrar el archivo;
  - carrera entre `cancel` y `done`: un solo resultado terminal y nunca borrar una grabación ya completada.
- Errores:
  - asset faltante;
  - códec no soportado;
  - worker sin soporte (si se simula);
  - fallo de carga/import del worker, error fatal y mensaje no deserializable;
  - escritura parcial/cuota/flush fallido y fallo al persistir metadata; cada caso debe terminar la promesa y limpiar o informar el parcial recuperable.
- Comprobar que el hilo principal no ejecuta la composición: instrumentar/contar que `renderFrame` no se llama en main durante el export.
- `npm run build`: verificar que el worker se emite como asset y queda precacheado por la PWA.
- Después de éxito/error/cancelación no quedan workers, listeners, timers ni handles abiertos. Agregar un smoke test de export desde el build servido offline; el test con Vite dev no verifica el precache del worker y sus fuentes.

### Riesgos específicos

- `AudioSample` planar y timestamps son el punto más delicado; los tests de RMS/tono/duración deben cubrirlo.
- Las fuentes en worker requieren `self.fonts`; verificar el pixel de texto, no solo que el worker termine.
- El archivo OPFS debe quedar bloqueado por el worker mientras el main mantiene el lock lógico; no abrir dos writers.
- La cancelación debe esperar el cierre del handle para no dejar el archivo bloqueado.
- Revisar el grafo de imports para evitar acceso a `document`/`window` durante la carga del módulo o en rutas ejecutadas por el worker. Un helper DOM aislado que no se ejecuta allí (por ejemplo `canvasThumbnail`) no vuelve inseguro por sí solo un módulo compartido; no duplicar el compositor por esa razón.

---

## Fase 5: escalado de timeline, biblioteca y medios

### 5.1 Virtualizar ticks de la timeline

Archivo: `src/lib/components/editor/Timeline.svelte`.

- Estado de viewport:
  - `scrollLeft`;
  - ancho visible;
  - `ResizeObserver` sobre el scroller;
  - evento `scroll`.
- Construir los ticks solo para el rango visible, con uno o dos ticks de margen.
- Mantener las posiciones absolutas actuales.
- Actualizar el rango al hacer zoom, fit y auto-scroll del playhead.
- Añadir un helper puro `visibleTicks(duration, pps, tickStep, scrollLeft, width)` para tests.

Criterio: con 1 h y zoom alto, el número de tick nodes depende del viewport, no de 3.600 segundos.

### 5.2 Miniaturas lazy en biblioteca

Archivo: `src/lib/components/LibraryView.svelte`.

- Añadir `IntersectionObserver` con `rootMargin` razonable.
- Mantener un set de ids visibles; `syncThumbnails` solo pide miniaturas de visibles y de la selección.
- No revocar una URL ya cargada solo porque la tarjeta salga del viewport; mantener la caché de URLs actual.
- Al abrir el detalle de una grabación, asegurar su miniatura aunque la tarjeta esté fuera de pantalla.
- Test: con muchas grabaciones, solo se solicita un subconjunto inicial y la seleccionada.

### 5.3 LRU de medios del preview

Archivo: `src/lib/editor/player.ts`.

- Límite de 3 `<video>` cargados.
- Mantener siempre:
  - medio activo;
  - medio preparado;
  - medio del clip pendiente, si existe.
- Al crear/cargar un medio, actualizar orden LRU.
- Compartir una promesa por `mediaId` desde antes de `await getFile()`; hoy dos llamadas concurrentes pueden pasar el chequeo del mapa y crear dos elementos/URLs para el mismo video.
- Proteger también el medio en preparación. Usar un único slot de precarga (preparando o preparado), cancelar referencias obsoletas y no asignar un cuarto video si todos los slots están protegidos; aplazar la precarga antes que expulsar el activo o el destino de un seek.
- Usar una generación de carga/reproducción para descartar resultados asíncronos obsoletos tras seek, suspend o dispose; si llega un archivo/carga tarde, liberar sus recursos en vez de repoblar el mapa. Una edición solo de overlays no invalida esa generación.
- Expulsar el menos reciente que no esté protegido:
  - pausar;
  - desconectar source/gain;
  - quitar `src` y llamar `load()` para liberar la carga/decodificador;
  - revocar URL;
  - quitar listeners/timers de carga y retirar el elemento del DOM y del mapa.
- `suspend()` sigue liberando todo.
- Añadir test de navegador con varios assets para comprobar que el activo nunca se expulsa y que se puede volver a cargar.
- Probar cargas concurrentes del mismo id, seeks rápidos y suspend/dispose mientras `getFile()` o `loadeddata` siguen pendientes; el límite debe contar elementos reales, no solo entradas del mapa.

### 5.4 Apertura de assets

- `#restoreAssets` vuelve a probar todos los videos y decodificar todas las imágenes al abrir.
- Mantener inicialmente el sondeo/validación de medios antes de normalizar el proyecto. La coincidencia de tamaño y metadata no prueba que el archivo sea válido; no prometer validación de corrupción mediante un fallback que nunca se ejecuta.
- Si el perfil muestra coste en el sondeo, evitar `computeFrameRateMetrics({ targetPacketCount: 128 })` cuando ya se conoce el fps del proyecto/grabación y no se necesita estimar el del medio. En particular, el export usa `project.fps` y no necesita recalcular el fps de cada asset. Conservar comprobación de pistas/códecs, timestamps y dimensiones; validar que esta ruta mantiene la misma salida y reparación de proyectos.
- Omitir completamente el sondeo exige una decisión posterior: validación diferida antes del primer uso y recuperación visible ante medio corrupto/incompatible sin reparar ni guardar destructivamente un proyecto aún no validado. No introducir esa complejidad como parte obligatoria de esta fase.
- Si se implementa carga lazy de imágenes en preview, hacerlo con caché y sin bloquear el primer render; para el export worker se decodifican solo las imágenes usadas.

Este punto es opcional si el perfil de apertura no muestra problema, pero forma parte del frente de escalado.

### 5.5 Rasterizar la waveform por viewport

Archivo: `src/lib/components/editor/Timeline.svelte`.

- Reutilizar el estado de viewport de 5.1. Hoy `drawWaveforms()` rasteriza la timeline completa hasta un límite de 8192 px y estira ese canvas sobre el contenido; a zoom alto se pierde detalle aunque casi todo esté fuera de pantalla.
- Posicionar un canvas sobre el rango visible con un pequeño margen; su backing store depende del ancho visible y DPR, no de `duration * pps`. Recortar clips al rango visible y convertir píxel local a tiempo global con el offset de scroll.
- Invalidar solo al cambiar rango, zoom, tamaño/DPR, bins o propiedades de clips que afectan al audio; ni el playhead ni una edición de texto/forma deben recalcular la firma de todos los clips o repintar audio. Separar esas dependencias de los snapshots de reproducción, conservando el cacheado de firma ya existente donde sea útil.
- Coalescer scroll/resize en un rAF y no cambiar `canvas.width/height` si no cambió el tamaño del backing store.
- Testear desplazamiento, zoom y trims con bins conocidos, y una timeline de 1 h: canvas acotado al viewport, mapeo de audio correcto y ninguna rasterización por cada avance del playhead.

---

## Fase 6: documentación y cierre

- Guardar este plan en la raíz del proyecto como `PLAN_OPTIMIZACION_EDITOR.md` y enlazarlo desde `README.md`.
- Actualizar `README.md`:
  - exportación en worker;
  - requisitos de navegador (OffscreenCanvas, WebCodecs, OPFS);
  - caché de waveform;
  - límites de preview y LRU.
- Actualizar `CONTINUACION_UI.md`:
  - arquitectura worker;
  - scheduler de preview;
  - caché y cola;
  - decisiones de no usar WASM/WebGPU en esta iteración.
- Revisar que las pruebas de recursos sigan cuadrando:
  - workers;
  - object URLs;
  - AudioContext del preview;
  - inputs de medios.
- Comprobar la PWA después de build, incluida la carga del worker.
- Este plan es el documento canónico; no sincronizar manualmente otra copia activa fuera del repositorio.

---

## Orden de implementación

1. Fase 0: medir y fijar la línea base; ejecutar la prueba mínima 0.1 de worker antes de comprometer la migración completa.
2. Fase 1: caches, scheduler de preview, compositor y coalescing.
3. Fase 2: WSOLA.
4. Fase 3: caché/concurrencia de waveform.
5. Fase 4: audio frames y export worker completo.
6. Fase 5: virtualización de ticks/waveform, miniaturas lazy y LRU de medios; sondeo liviano solo si lo justifica el perfil.
7. Fase 6: documentación y verificación final.

La prueba 0.1 no depende de optimizar WSOLA. La fase 4 integra el núcleo compartido y aprovecha la fase 2, pero ambas son mejoras independientes: no bloquear la validación del worker por una optimización de CPU. La fase 5 puede adelantarse después de la fase 1 si las mediciones muestran mayor impacto; su rasterización de waveform reutiliza el viewport de 5.1. No abrir trabajo paralelo sobre los mismos archivos del player/controller.

Las mejoras adicionales (firma de baseline, preparación conservada, cargas deduplicadas, timestamps/silencios incrementales y rasterización visible) se incorporan en sus fases, sin nuevos frameworks ni dependencias. Las optimizaciones opcionales se implementan solo con evidencia del perfil; no convertirlas en una reescritura del modelo o del pipeline de grabación.

## Verificación final

### Comandos

```bash
npm run check
npm test
npm run build
```

### Pruebas manuales

- Reproducir un proyecto 1080p30 en una pantalla de 120 Hz; comprobar que el canvas no redibuja a 120 Hz y que el corte entre clips sigue siendo fluido.
- Arrastrar un overlay y un borde de clip; comprobar latencia, una actualización por frame y undo correcto.
- Aplicar cambios consecutivos antes del rAF y guardar/exportar inmediatamente; descartar/cerrar con una edición pendiente. No debe perderse ni reaparecer un cambio.
- Exportar un MP4 y un WebM con:
  - corte;
  - mute;
  - volumen 0.5 y 1.5;
  - velocidad 1.5×;
  - texto;
  - forma;
  - imagen.
- Analizar con `ffprobe` y `ffmpeg` duración, códecs, audio y frames.
- Cancelar una exportación a mitad y comprobar que no queda una grabación completada ni un lock.
- Exportar un único clip largo, con y sin audio; observar memoria y adelanto A/V. Probar silencio largo y cancelación durante WSOLA/finalización.
- Abrir una grabación larga, comprobar el indicador de waveform, cerrar y reabrir para validar la caché.
- Abrir una biblioteca con muchas grabaciones y comprobar que las miniaturas se piden al hacer scroll.
- Abrir un proyecto con varios videos importados y verificar que el LRU no interrumpe el clip activo.
- Hacer seeks rápidos y cerrar mientras se cargan medios: no quedan elementos, URLs o cargas tardías fuera del LRU.
- Desplazar la timeline larga con zoom alto: ticks y waveform siguen el viewport y el playhead no repinta el audio.
- Servir el build, cargar/activar la PWA, pasar a offline y exportar con texto; validar el worker y las fuentes reales del build.
- Repetir en móvil/ventana estrecha.

### Criterio de aceptación global

- Sin regresiones funcionales.
- `npm test` completo, incluido export real desde worker.
- Build con worker y PWA correctos.
- Mejora medible en:
  - redraws de preview,
  - trabajo de main durante export,
  - allocaciones/tiempo de WSOLA,
  - segunda apertura de waveform,
  - nodos de ticks y rasterización visible de waveform en timelines largas,
  - memoria acotada durante exportación, incluidos huecos de audio.
- Sin WASM ni WebGPU en esta iteración.
