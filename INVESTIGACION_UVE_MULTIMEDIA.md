# UVE: hallazgos adicionales de multimedia en el navegador

Fuente local: `GodGMN/unnamed-video-editor`, commit **`2d2ca2664e1b53c4e54e98ae620cd65b1207ae46`** (`git rev-parse HEAD`). Las secciones 1–7 cubren exportación y su harness/test; las siguientes amplían playback, composición, importación y previews. Se contrastó también la documentación oficial de `CanvasSink`. No se modificó el código investigado ni la aplicación Ratorder.

**Sí hay más material interesante**, principalmente técnicas con APIs nativas del navegador, no nuevas dependencias. Se omiten los temas ya cubiertos: Mediabunny como biblioteca, fallback AAC/WASM y FFmpeg, propiedad/backpressure de VideoFrame, intercalado A/V, frameCache, signalsmith-stretch, imágenes animadas, handles y bundles portables.

## 1. Mezcla offline: reducir el grafo, no solamente acelerar el decoder

La exportación usa un `OfflineAudioContext` estéreo y de duración completa. Para cada clip, reúne los bloques decodificados en **un único `AudioBuffer`**, colocando cada fragmento según su timestamp y recortando los límites de copia. En la rama sin estiramiento crea un solo `AudioBufferSourceNode` por clip, en lugar de uno por bloque. El comentario documenta el motivo: miles de nodos programados encarecen el recorrido del render offline en bloques de 128 muestras. Es una optimización de la **topología del grafo de audio**, distinta de cambiar de codec.

Fuentes: [contexto y selección de clips, L111–115](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/exportSource.ts#L111-L115), [ensamblado temporal, L132–151](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/exportSource.ts#L132-L151), [nodo único, L162–166](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/exportSource.ts#L162-L166).

**Límite:** la motivación está documentada en código; no hay aquí un benchmark que cuantifique la mejora. Reunir buffers reduce nodos, pero conserva el audio completo del tramo de cada clip en memoria.

## 2. Automatización de ganancia mediante una curva de aproximadamente 1 ms

Para cada clip audible se evalúa `audioGain(...)` en aproximadamente mil puntos por segundo y se programa el resultado con `gain.gain.setValueCurveAtTime(...)`. El último punto consulta como máximo `end - 1/sampleRate`, evitando evaluar exactamente fuera del intervalo del clip. Web Audio ejecuta la curva durante el render; no se actualiza la ganancia desde un temporizador JavaScript.

Fuente: [exportSource.ts, L124–131](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/exportSource.ts#L124-L131).

**Límite:** es un muestreo de la función de ganancia, no una demostración de equivalencia sample a sample con el preview. La curva también escala con la duración: aproximadamente 3,6 millones de floats para una hora por clip.

## 3. Progreso real del render offline usando `suspend()` / `resume()`

Antes de `startRendering()`, programa suspensiones del `OfflineAudioContext` cada `max(5, duración/50)` segundos de **audio procesado**. Al alcanzar cada punto actualiza el progreso y reanuda el contexto. Así obtiene hitos del trabajo offline sin inventar un porcentaje basado en tiempo de pared. Si no existe `suspend`, omite los porcentajes; además ignora los rechazos de estas suspensiones.

Fuentes: [conexión al render, L170–175](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/exportSource.ts#L170-L175), [implementación, L187–195](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/exportSource.ts#L187-L195).

**Límite:** son hitos discretos, no una estimación de tiempo restante. La cancelación de esta fase se comprueba antes y después de `await ctx.startRendering()`; este código no interrumpe inmediatamente el render offline ya iniciado.

## 4. Decoder secuencial por clip y composición en el hilo con las fuentes cargadas

El worker genera una secuencia de timestamps de cada clip sobre la grilla de FPS del proyecto: arranca en `ceil(clip.start * fps)`, transforma cada instante con `toSource` y alimenta `samplesAtTimestamps(...)`. Mantiene un generador y un `Input` **por ID de clip**, aunque varios clips provengan del mismo archivo. Cada pedido avanza `stream.next()`; al terminar el clip devuelve el generador y libera el input.

Fuentes: [grilla y mapas, L14–21](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/render.worker.ts#L14-L21), [creación y avance, L26–41](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/render.worker.ts#L26-L41), [liberación, L49–56](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/render.worker.ts#L49-L56).

La decodificación devuelve `ImageBitmap` transferibles mediante `OffscreenCanvas`; la composición final permanece en el hilo principal expresamente para usar las mismas fuentes cargadas que el preview, tras cargar `700 72px Figtree`.

Fuentes: [puente de imágenes, L42–46](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/render.worker.ts#L42-L46), [fuentes, L34–37](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/exportSource.ts#L34-L37), [composición y cierre, L90–102](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/exportSource.ts#L90-L102).

**Límites:** no es un renderer de acceso aleatorio: `time` selecciona los clips activos, pero la muestra sale del siguiente elemento del generador. Presupone pedidos consecutivos sobre la misma grilla de FPS; repetir, saltear o retroceder tiempos no está resuelto. La composición sigue consumiendo hilo principal y se crea un `OffscreenCanvas` por muestra; no corresponde describir esta ruta como completamente off-thread ni zero-copy.

## 5. Reloj de salida reconstruido y duración cuantizada

La exportación calcula `frameCount = max(1, round(duration * fps))`, pide imágenes en `index/fps` y el worker construye sus `VideoSample` con ese timestamp y duración `1/fps`, incluso si recibió un `VideoFrame` con otro timestamp. El reloj final se reconstruye desde el índice, no desde la velocidad de ejecución ni desde el timestamp entrante. Los límites de audio usan redondeo de posiciones acumuladas, no sumar repetidamente un tamaño de bloque redondeado.

Fuentes: [cantidad de frames, L118–123](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/index.ts#L118-L123), [pedidos, L176–184](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/index.ts#L176-L184), [timestamps del encoder, L140–151](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/export.worker.ts#L140-L151), [límites de audio, L155–170](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/export.worker.ts#L155-L170).

**Límite verificable:** el reloj nominal no conserva cualquier duración decimal: 1,02 s a 24 fps produce 24 frames, nominalmente 1 s; 1,03 s produce 25, nominalmente 1,04167 s. El audio se recorta al menor entre su longitud y la duración cuantizada del video, sin rellenarlo explícitamente si queda más corto ([L125–131](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/export.worker.ts#L125-L131)). No se midieron aquí duraciones finales tras padding del codec.

## 6. Dos límites importantes: memoria total y cancelación

### Memoria: el límite de frames pendientes no limita toda la exportación

El mixdown completo se renderiza en RAM; `toPlanar()` copia todos sus canales antes de transferirlos, para no desprender los buffers del llamador. El MP4 utiliza además `BufferTarget` y `fastStart: 'in-memory'`, y se devuelve como un `ArrayBuffer` completo antes de crear el Blob. No hay escritura incremental a disco en esta ruta.

Fuentes: [mixdown, L115 y L170–175](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/exportSource.ts#L111-L175), [copia de canales, L224–235](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/index.ts#L224-L235), [destino del MP4, L118–121](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/export.worker.ts#L118-L121), [entrega, L180–187](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/export.worker.ts#L180-L187).

**Escala ilustrativa, no medición:** una hora estéreo float32 a 48 kHz son 1.382.400.000 bytes (≈1,29 GiB) solamente para un buffer de mezcla, antes de su copia, buffers de clips y MP4. No se calculó el pico real ni se probó una exportación de una hora.

### Cancelación: reproducido un hueco en la API `exportMp4`

El listener de abort sólo despierta `waitUntil()`. Si se aborta mientras `await renderFrame(...)` está pendiente, no existe una carrera con el AbortSignal: la promesa de exportación sigue pendiente y el `finally` que termina el worker todavía no se ejecuta. Contrasta con el comentario público que promete detener la exportación y desmontar el worker.

Fuentes: [contrato, L59–60](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/index.ts#L59-L60), [listener y espera, L158–169](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/index.ts#L158-L169), [await del renderer, L176–184](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/index.ts#L176-L184), [cleanup, L197–200](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/index.ts#L197-L200).

**Verificación ejecutada:** importación en memoria del módulo real con TypeScript eliminado por Node, `Worker`/`VideoFrame` simulados y un renderer controlable. Tras abortar y esperar 30 ms: exportación pendiente y cero terminaciones del worker. Al resolver el renderer: rechazo con la razón de abort y una terminación. Esto prueba el control de flujo de la API, no un fallo de codecs. La integración `exportSource` sí rechaza su pedido de worker pendiente al abortar ([L43–64](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/exportSource.ts#L43-L64)); no afirmar que todo cancel del editor queda colgado.

## 7. Diagnóstico útil, pero el harness no certifica sincronización A/V

`ExportTrace` inyecta reloj y logger, conserva inicio/fin de cada etapa y distingue tiempo total de etapa de tiempo sin actividad. Permite localizar qué dejó de avanzar sin registrar cada actualización de progreso. El test usa un reloj falso y verifica esas diferencias: **pasó 1/1** con `node --experimental-strip-types --test tests/export-trace.test.mjs`.

Fuentes: [traza, L22–70](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/trace.ts#L22-L70), [test, L5–29](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/tests/export-trace.test.mjs#L5-L29).

El harness fabrica pitidos de 80 ms cada segundo y un flash blanco correspondiente, exporta y vuelve a parsear el archivo para mostrar codecs, dimensiones, cantidad/tasa de paquetes y duración. Expone `window.exportHarness.run(...)` para automatizarlo.

Fuentes: [audio sintético, L148–163](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/dev/harness.ts#L148-L163), [flash, L181–184](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/dev/harness.ts#L181-L184), [inspección, L199–225](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/dev/harness.ts#L199-L225), [API, L313–334](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/dev/harness.ts#L313-L334).

**Límite de evidencia:** `ok: true` significa que exportar e inspeccionar no lanzaron una excepción; no compara los metadatos con valores esperados ni detecta automáticamente la coincidencia flash/pitido ([L248–265](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/export/dev/harness.ts#L248-L265)). No se ejecutó el harness en un navegador ni se verificó perceptualmente la sincronización.

## 8. Un compositor compartido, no dos interpretaciones del proyecto

`renderFrame(project, time, context, frameSource)` dibuja tanto el preview como la exportación. Acepta contextos de canvas normal u offscreen e inyecta el origen de frames; no depende de React ni del reproductor. Así, crop, escala, rotación, texto, keyframes y opacidad pasan por las mismas reglas. Es una medida contra discrepancias de implementación, no una garantía de igualdad de píxeles entre resoluciones o navegadores. La composición de exportación permanece en el hilo principal para utilizar las fuentes cargadas del documento.

Fuentes: [compositor, L98–157](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/playback/compositor.ts#L98-L157), [integración del preview](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/playback/engine.ts#L253-L258), [integración de exportación](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/exportSource.ts#L90-L102).

## 9. Keyframes en tiempo de origen

El modelo separa tiempo de timeline de tiempo del archivo: `source = inS + (timeline - start) * speed`. Los keyframes almacenan segundos de origen. Mover, recortar, dividir o cambiar la velocidad de un clip mantiene la animación vinculada al mismo contenido, en lugar de tener que reescribir todos sus tiempos. Los cambios temporales se propagan a los partners de audio/vídeo enlazados. Esto preserva la relación editorial; no demuestra sincronización de reproducción a nivel de muestra.

Fuentes: [conversiones temporales](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/model.ts#L274-L281), [keyframes y evaluación](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/keyframes.ts), [tests de preservación](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/tests/keyframes.test.mjs#L55-L66), [tests de velocidad](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/tests/speed.test.mjs#L69-L92).

## 10. Chroma key: sombras, bordes y contaminación de color

No usa solamente una distancia RGB al verde. Calcula crominancia Cb/Cr normalizada por brillo, con un piso para no amplificar ruido oscuro y una contribución de luminancia. `smoothstep` proporciona un borde parcialmente transparente. El despill elimina la componente de crominancia alineada con el color de fondo en los píxeles próximos al borde. El cuentagotas invierte posición, rotación y escala, respeta crop y convierte la coordenada a resolución de preview antes de muestrear el frame sin key.

El resultado se cachea en un `WeakMap` por objeto de frame y firma de configuración, evitando repetir el procesamiento mientras está pausado. El algoritmo recorre RGBA en CPU; no se midió su rendimiento a 4K ni debe describirse como un shader GPU.

Fuentes: [algoritmo y caché](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/playback/chromaKey.ts), [transformación inversa](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/playback/compositor.ts#L81-L96), [muestreo a resolución de preview](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/playback/engine.ts#L269-L283).

**Detalle de propiedad:** `FrameCache` usa `CanvasSink` con `poolSize: 0`. La documentación confirma que crea canvases nuevos en lugar de reutilizarlos en anillo. Inferencia: esta elección es coherente con retener referencias a frames y cachear efectos por identidad; activar un pool exigiría revisar ambas cosas para no confundir un objeto reciclado con el frame anterior. No es una optimización gratuita: aumenta el trabajo de asignación/liberación.

Fuentes: [configuración](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/playback/frameCache.ts#L98-L103), [contrato oficial de poolSize](https://mediabunny.dev/api/CanvasSinkOptions#poolsize).

## 11. Forma de onda con memoria de salida acotada

La generación de preview consume `AudioBufferSink.buffers()` por bloques. Cada muestra se coloca en un bin según `timestamp + i/sampleRate`, guardando el máximo absoluto entre canales. Se limita a 20.000 bins, en lugar de conservar un PCM de toda la grabación para dibujar la onda. El vídeo genera como máximo 40 miniaturas de 160×90 mediante una secuencia ordenada de timestamps.

**Límites:** la forma de onda aún requiere decodificar y recorrer todo el audio; no es un sondeo instantáneo ni una pirámide multirresolución para zoom extremo. La ejecución por bloques no demuestra que los bucles JS nunca bloqueen la UI. La reducción de salida sí es explícita en código.

Fuentes: [generación de miniaturas y peaks](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/media/import.ts#L107-L137), [API de timestamps ordenados](https://mediabunny.dev/api/CanvasSink#canvasesattimestamps).

## 12. Presupuesto de animaciones y de previews persistidos

Para una animación con N frames RGBA estima `N * width * height * 4` bytes. Si supera 256 MiB, reduce las dimensiones lineales por `sqrt(budget/estimatedBytes)`, además de ajustarlas al tamaño del preview. Es un presupuesto estimado de bitmaps, no un límite del proceso: no incluye memoria transitoria del decoder, overhead, otras animaciones ni las miniaturas.

Las previews persistidas se limitan por separado a 128 MiB; ante presión elimina primero entradas con timestamp de escritura más antiguo y tolera `QuotaExceededError`. No es un LRU estricto: leer una preview no actualiza `used`. La regeneración comparte una promesa pendiente por media ID para evitar trabajos duplicados.

Fuentes: [resolución adaptativa](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/playback/frameCache.ts#L48-L71), [caché persistida](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/media/files.ts#L60-L85), [deduplicación de regeneración](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/media/PreviewStrip.tsx#L8-L25).

## 13. El reloj no depende de React, pero tampoco es sample-accurate

El preview calcula el tiempo desde un ancla y `performance.now()`, no sumando `1/fps` por callback. Dibuja con `requestAnimationFrame` y publica el playhead en React aproximadamente cada 100 ms. La preparación de cada clip es asíncrona; mantiene activos los clips visibles y precalienta hasta dos entradas próximas dentro de dos segundos. Conserva como máximo dos entradas inactivas; el número de entradas activas sigue dependiendo del proyecto.

El audio utiliza elementos HTMLAudioElement. Durante reproducción en marcha sólo corrige con seek si la deriva supera 0,25 s; en preparación/pausa usa un umbral de 0,002 s. También suaviza cambios de ganancia con una constante de 10 ms. Esta estrategia prioriza continuidad y capacidad de respuesta; no prueba precisión A/V de muestras ni debe trasladarse sin más a captura en vivo.

Fuentes: [reloj y publicación](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/playback/usePlayback.ts#L29-L87), [preparación y evicción](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/playback/engine.ts#L80-L129), [sincronización de audio](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/playback/engine.ts#L161-L190).

## 14. Importación en dos fases sin resucitar estados incompletos con undo

Primero sondea todos los archivos del lote y permite colocarlos con su duración real, marcados `importing`; después enlaza fuentes y genera previews en una cola secuencial. La finalización/cancelación enmienda también las instantáneas de undo/redo, no sólo el presente. Esto evita restaurar un archivo como eternamente importando o reintroducir una importación fallida al hacer redo. Si el usuario recarga durante la importación, se descartan los medios incompletos y sus clips.

Fuentes: [cola de importación](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/media/useImports.ts), [enmienda de historial](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/history.ts#L28-L31), [test de undo/redo](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/tests/history.test.mjs#L20-L26), [recuperación tras recarga](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/editor/useProject.ts#L47-L55).

## Matices de la revisión anterior

- Transferir VideoFrame/ImageBitmap evita clonar esos objetos entre hilos, pero no vuelve zero-copy a toda la ruta: hay rasterización intermedia en canvas, composición y copias de audio.
- El encoder recibe el formato del audio preparado; en la integración del editor se prepara una mezcla estéreo a 48 kHz. No preserva necesariamente los canales/sample rate de cada archivo original. [Configuración del diálogo](https://github.com/GodGMN/unnamed-video-editor/blob/2d2ca2664e1b53c4e54e98ae620cd65b1207ae46/src/components/ExportDialog.tsx#L31-L32).
- Limitar frames pendientes no limita la memoria total, y sincronización editorial por timestamps no equivale a sincronización sample-accurate del preview.

## Verificación de esta ampliación

Se ejecutaron los tests existentes de chroma, keyframes, velocidad, historial y fades de vídeo: **39/39 aprobados**. El test de trazas ejecutado en la investigación de exportación pasó **1/1**. La ejecución conjunta final de los seis archivos confirmó **40/40 aprobados**. No se ejecutó la app ni se midieron codecs, fluidez, memoria o sincronización en un navegador. Los límites identificados por inspección se distinguen de la reproducción controlada de cancelación descrita arriba.
