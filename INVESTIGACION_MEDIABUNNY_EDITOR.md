# Mediabunny: oportunidades de rendimiento en Ratorder

Pregunta: ¿hay procesos del editor donde Mediabunny permita acelerar algo que hoy no aprovecha bien?

Revisado contra `mediabunny@1.65.0` instalado localmente y su documentación/API oficial vigente. Esta nota no contiene benchmarks: separa oportunidades comprobables del resultado aún desconocido y evita sugerir cambiar la semántica del editor por una función de conversión.

## Recomendaciones

### 1. Analizar la waveform con `AudioSampleSink`, no pasar por `AudioBuffer`

`computeAudioWaveform()` solo lee canales, timestamps y energía por muestras para llenar bins RMS; no usa Web Audio ni necesita un `AudioBuffer`. Hoy `AudioBufferSink` convierte cada sample decodificado en un `AudioBuffer`; en el source local, `AudioBufferSink._audioSampleToWrappedArrayBuffer` llama `sample.toAudioBuffer()` antes de entregarlo. [`media.ts:185–195`](src/lib/editor/media.ts), [`media-sink.ts:2801–2810`](node_modules/mediabunny/src/media-sink.ts).

La API de `AudioSampleSink` expone samples decodificados y permite iterarlos en orden; se pueden copiar los planos necesarios como `f32-planar`, medir bins directamente y cerrar cada sample. Eso elimina la capa `AudioBuffer`/`getChannelData`, pero **no** elimina el decode, el recorrido de muestras ni el costo actual de calcular bins en main; comprobar allocaciones y responsiveness antes de declarar una ganancia. Conserva el stride, alineación por timestamp, conteo por canal y RMS actuales.

Fuentes oficiales: [media sinks](https://mediabunny.dev/guide/media-sinks), [packets & samples](https://mediabunny.dev/guide/packets-and-samples).

**Prioridad: alta; riesgo semántico bajo.** Se puede implementar independientemente del export worker y la caché de waveform del plan. La caché evita trabajo al reabrir; `AudioSampleSink` evita una adaptación en el primer análisis, cuya mejora de tiempo/asignaciones debe medirse.

### 2. Evitar la copia `CanvasSink → renderFrame` como experimento medido

En el export actual, `CanvasSink` decodifica y rasteriza cada frame a una superficie temporal; `renderFrame` la vuelve a dibujar sobre el canvas de composición antes de codificar. [`media.ts:119–125`](src/lib/editor/media.ts), [`export.ts:351–363`](src/lib/editor/export.ts). El código de Mediabunny muestra que `CanvasSink` llama internamente a `_drawWithFitAndMipmapping`, mientras que `VideoSample` ofrece un `draw(context, ...)` público que permite dibujar una muestra en un canvas. [`media-sink.ts:2227–2245`](node_modules/mediabunny/src/media-sink.ts), [`sample.ts:1136–1166`](node_modules/mediabunny/src/sample.ts).

En un prototipo se podría usar `VideoSampleSink` y `VideoSample.drawWithFit()`, dibujar la muestra directamente sobre el canvas final y luego los overlays, evitando el canvas temporal por frame. No es un cambio drop-in: hay que reproducir orientación/flip, fit, SAR, barras negras del sink y fondo `#090B0F` del compositor, alpha y color, y comparar downscaling visual. `CanvasSink` aporta mipmapping al escalar; `drawWithFit()` no recorre esa misma ruta interna. La API directa puede ahorrar una copia de composición, **no** garantiza menos decode/encode ni mejor throughput global. Mantener `CanvasSink` si el decode o la conversión para escalar domina, o si cae calidad.

Fuentes oficiales: [media sinks / CanvasSink](https://mediabunny.dev/guide/media-sinks), [VideoSample.drawWithFit](https://mediabunny.dev/api/VideoSample#drawwithfit).

**Prioridad: media, como prueba A/B tras el worker.** Medir `renderFrame`, CPU/GPU y memoria; comparar muestras 4K→1080p, aspect ratios, rotaciones y colores planos con tolerancia visual. El plan ya mide composición, pero aún no propone esta alternativa.

### 3. Medir preferencias de aceleración en decoder/encoder; no forzarlas a ciegas

Mediabunny expone `hardwareAcceleration: 'no-preference' | 'prefer-hardware' | 'prefer-software'` tanto en `CanvasSink`/`VideoSampleSink.decoderOptions` como en la configuración del encoder. [`CanvasSinkOptions` y defaults en media.ts:119–125](src/lib/editor/media.ts), [`VideoSampleSource` en export.ts:228–241](src/lib/editor/export.ts). El encoder puede recibir `hardwareAcceleration`; la selección del codec que hace `media/codecs.ts` consulta si el browser puede codificarlo, no si un modo hardware concreto es el óptimo. [`codecs.ts:22–37`](src/lib/media/codecs.ts).

La documentación recomienda dejar `'no-preference'` como default. Hardware no equivale a “más rápido” en todas las resoluciones/codecs/GPUs y algunos equipos no soportan la configuración preferida. Hacer una matriz experimental codec × resolución × preference, medir encode y decode por separado y fallback automático si la inicialización falla; no fijarlo como requisito de exportación. Además `latencyMode: 'realtime'` puede descartar frames cuando el encoder no alcanza tiempo real, así que **no** es un toggle seguro para exportar un archivo offline.

Fuentes oficiales: [VideoEncodingConfig](https://mediabunny.dev/api/VideoEncodingConfig), [media sinks / decoder options](https://mediabunny.dev/guide/media-sinks), [WebCodecs hardwareAcceleration](https://www.w3.org/TR/webcodecs/).

**Prioridad: experimento acotado; no se justifica cambio de producto sin benchmark.** El plan ya define codec y pruebas de duración; añadir esta preferencia a las mediciones de worker si la codificación resulta cuello de botella.

### 4. Cerrar explícitamente las sources al terminar de alimentarlas

El export llama `output.finalize()` al final, pero no `videoSource.close()`/`audioSource.close()` al terminar de agregar muestras. [`export.ts:228–255, 351–393, 461`](src/lib/editor/export.ts). Mediabunny documenta `MediaSource.close()` como opcional pero recomendado después de la última muestra para mejorar rendimiento y reducir memoria. [`media-source.ts:141–174`](node_modules/mediabunny/src/media-source.ts).

Llamar `close()` cuando la pista realmente terminó de recibir muestras (ambas fuentes antes de finalización) permite señalizar antes el fin del stream y puede acelerar cierre/drenado de encoders. Debe coordinarse con el caso sin audio y errores/cancelación; no cerrar por clip porque es una sola pista continua. Ganancia esperada pequeña frente al costo de decodificación/composición.

Fuente oficial: [media sources](https://mediabunny.dev/guide/media-sources).

**Prioridad: baja; cambio simple con prueba de MP4/WebM, cancelación y finalización.** El plan ya prueba cerrar writer/handles, pero no cerrar las fuentes del muxer antes de `finalize()`.

## Funciones que ya se aprovechan bien o no son atajos seguros

- **`CanvasSink.poolSize: 2` ya está configurado** en `probeMedia`. Mediabunny documenta que el pool recicla canvases y acota asignaciones/VRAM; no hay motivo para aumentarlo sin medición. La iteración del export es secuencial y el sink se usa para muestreo ordenado.
- **`canvasesAtTimestamps()` es apropiado** al mapear cada instante de la timeline a tiempo fuente en clips acelerados/recortados. La API optimiza timestamps ordenados y acepta iterables: el plan ya corrige el array completo de timestamps por un generador. Para reproducción continua de la fuente se prefiere `canvases()`; aquí no equivale cuando hay velocidad, saltos y composición.
- **`StreamTarget` chunked + MP4 fragmented ya mitiga acumulación y permite escritura progresiva.** Mediabunny aún puede retener paquetes de una pista esperando la otra; el intercalado de audio/video del plan sigue siendo necesario.
- **`Conversion`/remux no reemplaza el export general del editor.** Copiar packets puede evitar decodificar/recodificar en conversiones compatibles, pero trims por keyframe pueden expandir o recortar bordes. Evaluar cada pista por separado: cambiar solo el audio no obliga por sí mismo a recodificar el video, mientras overlays o cambios de dimensiones sí requieren procesarlo. Un fast path debe preservar cortes exactos, timestamps, códecs, fps y el contrato de calidad/bitrate; copiar el original no satisface automáticamente un preset de recodificación. Investigar primero un caso compatible de un único medio, sin montar un segundo pipeline general ni asumir que `Conversion` resuelve montajes arbitrarios. En un prototipo de trims, exigir `boundaryTolerance: 0` y `shiftTolerance: 0`; si no puede copiar con esos límites, transcodificar o rechazar ese fast path, nunca ampliar silenciosamente el corte.
- **`AudioEncodingConfig.transform`**, al configurar `AudioSampleSource`, puede remuestrear, hacer up/downmix de canales y procesar muestras en el encoder; no mezcla automáticamente varias pistas ni reemplaza ganancia/WSOLA por clip. En Ratorder WSOLA consume PCM normalizado antes del encoder: mover el resampling al final no es una sustitución directa del núcleo actual.
- **`CanvasSource` no es una aceleración por sí sola.** Su `add(timestamp, duration)` construye internamente un `VideoSample` del canvas y usa el mismo encoder que el código manual actual; puede simplificar ownership, pero no elimina la composición ni la captura del canvas. Ver [`media-source.ts:1536–1545`](node_modules/mediabunny/src/media-source.ts) y [CanvasSource](https://mediabunny.dev/guide/media-sources#canvassource).

Fuentes oficiales: [writing media files / interleaving y backpressure](https://mediabunny.dev/guide/writing-media-files#packet-buffering), [converting media / copy y trims](https://mediabunny.dev/guide/converting-media-files), [AudioTransformOptions](https://mediabunny.dev/api/AudioTransformOptions).

## Conclusión

La oportunidad concreta de menor riesgo que no está ya en el plan es cambiar el análisis de waveform a `AudioSampleSink` y medir el camino sin `AudioBuffer`. La oportunidad con mayor techo en la exportación es evitar el canvas intermedio, pero requiere prueba visual por mipmapping y ajustes; no darla por ganancia confirmada. Preferencias de hardware y `close()` temprano son experimentos menores, no sustituyen la estrategia del worker/interleaving.
