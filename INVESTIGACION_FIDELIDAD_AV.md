# Fidelidad audiovisual: evidencia y prioridades

**Actualización:** se implementaron los avisos al terminar una pista de audio,
la identificación de grabaciones activas entre pestañas mediante Web Locks y
la ruta de video sin Canvas cuando no hace falta escalar. Las mediciones y
problemas descritos más abajo corresponden al comportamiento anterior al cambio.
La prueba `npm run test:recording` verifica estas rutas y la recuperación de una
sesión abandonada; requiere Chromium y ffmpeg. Para Vivaldi se puede definir
`CHROMIUM_PATH=/usr/bin/vivaldi`.

Consulta: 31/10/2026. Caso informado: Vivaldi/Linux, micrófono desactivado, audio del sistema, balanced/720p, 30 fps, MP4 fragmentado cada 2 s, audio 192 kbit/s. El usuario confirmó que retirar `transform.numberOfChannels=2/sampleRate=48000` eliminó la distorsión severa. **Eso no identifica la causa de las diferencias restantes.** Se ejecutaron las pruebas sintéticas descritas al final; no se capturó el escritorio real ni se inspeccionó la configuración de audio, ICC o HDR del usuario.

Leyenda: **L** = confirmado leyendo el código local; **D** = comportamiento documentado, no garantía de implementación; **H** = hipótesis pendiente de medición. Los borradores actuales y Chromium `main` no equivalen necesariamente a la versión integrada en Vivaldi.

## 1. Ruta local comprobada

- **L:** `recording-controller.ts` crea el mezclador **solo si hay micrófono**. Sin él, entrega directamente la pista del sistema a `MediaStreamAudioTrackSource`, sin transformación de audio. El compresor, los dos canales y los 48 kHz de `audio-mixer.ts` no intervienen en este caso. La cancelación de eco, reducción de ruido y AGC explícitas del controlador corresponden a `getUserMedia` del micrófono, no a `getDisplayMedia`. [Controlador](src/lib/recording/recording-controller.ts), [mezclador](src/lib/recording/audio-mixer.ts).
- **L:** MP4 prueba AAC y después Opus: **MP4 no demuestra AAC**. El sondeo de capacidad todavía usa 2 canales/48 kHz; no convierte la pista. Mediabunny configura el codificador con los parámetros de la primera muestra: conviene sondear el formato real para evitar discrepancias de soporte. [Controlador](src/lib/recording/recording-controller.ts), [Mediabunny 1.65.0, `ensureEncoder`](https://github.com/Vanilagy/mediabunny/blob/v1.65.0/src/media-source.ts).
- **L:** basta especificar canales o frecuencia en `transform` para activar `AudioResampler`, incluso si coinciden con la entrada. Este posiciona bloques por timestamp, interpola linealmente y suma solapamientos. Es compatible con la mejora informada, **no prueba por sí solo que hubiera jitter en esa PC**. Sin ese transform todavía existe relleno de huecos con silencio en el codificador. [Fuente](https://github.com/Vanilagy/mediabunny/blob/v1.65.0/src/media-source.ts), [remuestreador](https://github.com/Vanilagy/mediabunny/blob/v1.65.0/src/resample.ts).
- **L:** balanced limita el lado largo a 1280, conserva proporción y solicita 4 Mbit/s a 30 fps. No promete conservar píxeles de una pantalla mayor. El controlador siempre pasa ancho/alto a `transform` de video. [Configuración](src/lib/recording/config.ts), [controlador](src/lib/recording/recording-controller.ts).

## 2. Audio: separar captura, codificación y reproducción

**D:** no es defendible afirmar «Chromium siempre elimina procesamiento al capturar pantalla». Su selector actual distingue micrófono, extensiones y otras capturas —incluido `getDisplayMedia`— y resuelve eco/AGC/ruido según candidatos y restricciones. Un comentario genérico sobre “content capture” no basta para extrapolar todas las rutas. **H:** podría existir procesamiento del navegador o del sistema, pero no está probado aquí. Registrar versión exacta, superficie elegida, `getSupportedConstraints()`, `getConstraints()` y `getSettings()` de la pista; propiedades ausentes no demuestran audio sin procesar. [Chromium: selección de audio](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediastream/media_stream_constraints_util_audio.cc).

**D:** `suppressLocalAudioPlayback` afecta a los altavoces de la pestaña capturada; el audio debe seguir capturándose. No es un control de fidelidad. `restrictOwnAudio` intenta excluir el audio generado por el documento capturador, mediante procesamiento o exclusión de su señal. `systemAudio: 'include'` expresa una preferencia, no garantiza una pista ni determinada fuente. **L:** Ratorder no fija explícitamente aquellas dos restricciones. **Prioridad:** comprobar soporte/estado antes de una comparación controlada; no imponerlas indiscriminadamente ni confundir supresión de reproducción con supresión de ruido. [W3C Screen Capture](https://www.w3.org/TR/screen-capture/).

**D:** AAC es codificación perceptual con cuantización; Opus también utiliza compresión perceptual, permite mono/estéreo y distintos anchos de banda. Su modo fullband llega a 20 kHz aunque opere a 48 kHz. Por tanto, **48 kHz, dos canales o 192 kbit/s no significan identidad con PCM ni garantizan separación estéreo intacta**. El perfil/implementación y contenido importan; no corresponde diagnosticar un recorte fijo de AAC sin analizar la salida. [Fraunhofer, paradigmas de codificación](https://www.iis.fraunhofer.de/content/dam/iis/de/doc/ame/wp/FraunhoferIIS_Technical-Paper_EVS.pdf), [RFC 6716, §2](https://www.rfc-editor.org/rfc/rfc6716.html#section-2).

**H y medición propuesta:** comparar un estímulo conocido contra PCM capturado antes del codificador y contra audio decodificado, alineados y con volumen igualado. Medir RMS/pico, espectro, canales y correlación L/R; escuchar A/B sin reproducción simultánea de original y grabación. Una pista de dos canales puede contener mono duplicado. Mezclador del escritorio, dispositivo de salida y reproductor son variables por controlar, no culpables confirmados.

## 3. Color: transformación real frente a etiquetas

**L:** Mediabunny 1.65.0 activa transformación mediante Canvas cuando hay ancho/alto configurados, **incluso sin cambiar dimensiones**. `VideoSample.transform()` dibuja en Canvas 2D y crea otra muestra; sus contextos no solicitan gama ampliada ni precisión flotante. El constructor desde Canvas identifica esa muestra como RGB/sRGB, primarias BT.709 y rango completo. La ruta directa desde `VideoFrame` conserva sus campos cromáticos reconocidos. [Transformación y constructor](https://github.com/Vanilagy/mediabunny/blob/v1.65.0/src/sample.ts), [activación](https://github.com/Vanilagy/mediabunny/blob/v1.65.0/src/media-source.ts).

**D:** Canvas 2D usa por defecto sRGB y `unorm8`; su gestión de color convierte entre espacios y hacia el dispositivo. **H:** pasar una captura amplia/HDR por esta ruta puede reducir gama/precisión; no sabemos si la fuente del usuario era HDR ni qué transformación había realizado ya Chromium. ICC/compositor/pantalla pueden intervenir en la apariencia. No hay evidencia para atribuirles este caso. [HTML: Canvas y color](https://html.spec.whatwg.org/multipage/canvas.html#colour-spaces-and-colour-space-conversion).

**D:** RGB/sRGB y YUV BT.709 no son etiquetas intercambiables: comparten primarias, pero difieren en transferencia/matriz; WebCodecs distingue `primaries`, `transfer`, `matrix` y `fullRange`. I420/NV12 son 4:2:0: reducen resolución cromática, visible especialmente en texto/bordes saturados. **H:** medir el formato real; no inferirlo solo por MP4. Un error de rango puede alterar negros/contraste, pero aún no está demostrado. [WebCodecs: espacios y formatos](https://www.w3.org/TR/webcodecs/).

**Recomendación:** preservar esos cuatro campos cuando los píxeles no cambian; tras una conversión, describir **los píxeles resultantes**, no copiar ciegamente HDR/BT.2020 o el rango original. Preservar también dimensiones, tiempos/duración y configuración del decodificador producida por el codificador. Mediabunny escribe `colr/nclx` desde `decoderConfig.colorSpace`; verificar señalización y bitstream, no reemplazarlos arbitrariamente por «BT.709 limited». [MP4 local](https://github.com/Vanilagy/mediabunny/blob/v1.65.0/src/isobmff/isobmff-boxes.ts).

No forzar `fullRange=true`, gamma, ICC ni `colorSpaceConversion:'none'` como arreglo visual: este último controla APIs como ImageBitmap/ImageDecoder, no desactiva globalmente la gestión de color de captura/video. Primer experimento propuesto: comparar ruta directa sin Canvas y ruta actual, con parches SDR/grises y mismo reproductor; mantener HDR como investigación separada. [WebCodecs](https://www.w3.org/TR/webcodecs/).

## 4. Grabaciones largas y prioridades

- **Integridad, riesgo documentado no sometido a estrés:** ambas fuentes locales descartan muestras cuando la cola llega a 8; video fuerza `latencyMode:'realtime'`. Sobrecarga del hilo principal/codificador o escritura lenta puede generar saltos, no simplemente menor calidad. Instrumentar colas, descartes, timestamps y deriva A/V. Fragmentos de 2 s no eliminan estos riesgos. [Mediabunny](https://github.com/Vanilagy/mediabunny/blob/v1.65.0/src/media-source.ts).
- **Almacenamiento, lectura local:** `App.svelte` ya consulta `estimate()` y solicita `persist()` al iniciar, pero descarta el resultado de persistencia y no muestra ni vigila el margen de cuota durante la grabación. El controlador sí intenta conservar el archivo parcial ante un error de escritura. Conviene comprobar y comunicar el resultado de persistencia y avisar antes de agotar el espacio. Persistencia protege frente a eviction automática, **no aumenta ilimitadamente la cuota ni garantiza espacio físico**. Estimación nominal propia: (4.000.000 + 192.000)/8 × 3600 ≈ **1,89 GB/h**, más overhead y variación VBR. [Storage Standard](https://storage.spec.whatwg.org/).
- **Continuidad, pendiente de prueba real:** observar `visibilitychange`, `freeze/resume`, pistas silenciadas/finalizadas y estado de AudioContext cuando exista. Una página congelada suspende tareas; `beforeunload` no garantiza cierre. Captura activa no equivale a inmunidad universal frente a descarte, suspensión del sistema o cierre del navegador. [Chrome: ciclo de vida](https://developer.chrome.com/docs/web-platform/page-lifecycle-api).
- **Fidelidad:** identificar formato/códec reales y separar captura→codificación→reproducción; después comparar Canvas/directo. Ajustar bitrate/perfil únicamente si la pérdida queda localizada en el codificador. No reincorporar transformaciones de audio para “asegurar estéreo”.

## Mediciones locales — realizadas

Comandos reproducibles (requieren dependencias del proyecto, Chromium/Vivaldi y ffmpeg/ffprobe):

```bash
node scripts/inspect-fidelity.mjs > /tmp/ratorder-av-chromium.json
CHROMIUM_PATH=/usr/bin/vivaldi node scripts/inspect-fidelity.mjs > /tmp/ratorder-av-vivaldi.json
npm test
npm run check
```

Entorno: Chromium **155.0.8059.79**; Vivaldi **8.2.4133.94**, cuya UA headless informó motor **152**; Mediabunny **1.65.0**. Cada ejecución usa un perfil temporal aislado. La captura se sustituye por pistas sintéticas, pero codificación, controlador y OPFS son reales. La variante sin transform se carga **solo en memoria**; no modifica el motor de la aplicación.

### Color: tres etapas observadas

Entrada I420 BT.709 de rango limitado, **1280×720**, con 16 parches planos. Preferencias balanced, 30 fps, MP4/4 Mbit/s. Se comparó un píxel central de cada parche antes de codificar y después de reproducir el archivo en **el mismo navegador**, convertido a sRGB mediante Canvas. No es una medición calibrada ni compara todos los píxeles del video.

| Navegador | Ruta actual: error RGB medio / máximo | Sin transform de video: medio / máximo |
|---|---:|---:|
| Chromium | 0,417 / 3 | 0 / 0 |
| Vivaldi | 0,688 / 3 | 0 / 0 |

Unidades: niveles de canal de 0 a 255. **Las diferencias SDR medidas son pequeñas**. Cero en parches planos no significa compresión sin pérdidas, ni demuestra que la ruta directa arregle la captura real del usuario. Los grises de referencia se mantuvieron en esta prueba; no apareció un fallo generalizado de negros/rango.

El camino actual convirtió la entrada **I420/BT.709/limited → BGRA/sRGB/full** antes de codificar. Después del H.264, Chromium escribió BT.709/sRGB/full; Vivaldi escribió SMPTE170M/limited. La variante directa conservó I420/BT.709/limited en ambos. Las diferencias entre navegadores son reales, pero sus etiquetas por sí solas no prueban colores incorrectos: importa la conversión efectiva y el reproductor.

En una prueba independiente de **Display-P3**, `VideoSample.transform()` convirtió efectivamente a sRGB, incluso a igual tamaño. Un rojo P3 `[255,0,0]` regresó como `[234,51,35]` al leerlo de nuevo en coordenadas P3; el verde `[0,255,0]` pasó a `[117,251,76]`. Esto confirma pérdida de gama en esa ruta, **no confirma que la pantalla del usuario sea P3/HDR**. HDR y perfiles ICC reales siguen sin probarse.

**Mejora defendible para una siguiente tarea:** evitar Canvas cuando no hace falta redimensionar. Si se necesita bajar de una pantalla mayor a 720p, conservar el escalado pero diseñar y probar explícitamente la conversión SDR/gama amplia; no retirar el escalado sin reemplazo ni copiar etiquetas incompatibles con los píxeles resultantes.

### Audio: canales, ganancia y banda

Se grabaron señales distintas por canal: L a 440/4000/12000/18000 Hz; R a 880/6000/14000/19500 Hz, amplitud 0,06 por tono. Sin micrófono, 48 kHz estéreo/192 kbit/s solicitado. **Ambos navegadores eligieron Opus dentro del MP4**, no AAC. ffmpeg confirmó dos canales/48 kHz. Se conservaron los tonos propios y la separación entre canales; la diferencia de RMS frente al estímulo conocido quedó aproximadamente entre −0,15 y +0,05 dB.

No apareció una modificación fuerte de volumen, conversión a mono ni pérdida completa de los agudos de esa señal. Tampoco prueba transparencia para música compleja: Opus sigue siendo con pérdidas y la prueba no pasó por el mezclador del escritorio, la captura real de pantalla ni el dispositivo de reproducción. **La causa precisa de “se escucha distinto” continúa abierta.** Si se activa el micrófono, el compresor local sí modifica deliberadamente la dinámica de la mezcla; no explica el caso actual sin micrófono.

### Dos problemas de experiencia reproducidos

1. **Pérdida de audio sin aviso.** Tras detener la pista sintética y emitir `ended`, el snapshot siguió con `systemAudioActive=true` y `hasAudio=true`, sin aviso de pérdida. El archivo terminó como `completed`: unos 2,6 s de video y solo unos 1,0 s de audio. Reproducido en ambos navegadores. El controlador observa `ended` del video, no del audio. Debe distinguir disponibilidad inicial de continuidad y avisar si la pista termina o queda silenciada. No se modificó esta conducta.
2. **Falsa recuperación con otra instancia.** Mientras el controlador grababa, una segunda instancia de `RecordingStore.initialize()` leyó la grabación activa y la marcó `interrupted`. Es la misma ruta de recuperación que ejecuta otra pestaña al cargar. La grabación pudo finalizar correctamente después; **no se demostró pérdida de bytes**. La recuperación no distingue una sesión caída de una sesión activa en otro contexto. Debe comprobar propiedad/actividad antes de reclasificar.

### Aclaración posterior: reproducción dentro de Ratorder

El usuario confirmó que observa la diferencia en el reproductor de la biblioteca,
al ver el archivo ya guardado, no en un reproductor externo.

Se amplió `scripts/inspect-fidelity.mjs` para copiar las escrituras del muxer antes
de transferirlas al worker, reconstruir el archivo esperado por posición y
comparar su SHA-256 y longitud con `RecordingStore.getVideoFile()`. Los tres
escenarios coincidieron byte a byte en Chromium y en Vivaldi. Es una prueba de
integridad de almacenamiento con archivos sintéticos, no una medición de la
captura real del usuario.

El reproductor de `RecordingDetail.svelte` usa directamente una URL de Blob del
archivo; no vuelve a codificarlo. No se encontraron filtros de color, opacidad
persistente ni mezcla CSS aplicados al video en los estilos de la app. Esto no
evalúa extensiones ni ajustes externos de Vivaldi.

La diferencia observada al pasar de captura/vista previa a archivo reproducido
debe investigarse en la conversión/codificación y en la interpretación cromática
del video por el navegador. El guardado no añadió cambios a los datos en estas
pruebas. Conviene precisar si se lavan negros/contraste, cambia la luminosidad de
los tonos medios o se altera la saturación antes de proponer una corrección.

### Orden sugerido y límites

1. Avisar pérdida de audio y corregir la detección de sesiones activas entre pestañas.
2. Evitar conversiones de video innecesarias y añadir regresiones de color/canales con formatos y metadatos reales.
3. Añadir estado de persistencia y alertas de espacio; medir descartes y deriva bajo carga y en grabaciones largas antes de prometer continuidad.
4. Comparar un fragmento original/grabado del usuario con el mismo reproductor y volumen; registrar superficie capturada, settings reales y estado SDR/HDR/ICC.

`npm test`: dos regresiones de audio aprobadas; `npm run check`: 0 errores y 0 advertencias. Las sesiones de diagnóstico duran unos 2,5 s: **no validan horas de grabación, suspensión ni recuperación ante cuota agotada**. Las pruebas de esta sección no cambiaron código de producción; el cambio de restricciones de audio se describe en la última sección.

### Captura real automatizada con agent-browser (31/10/2026)

Sí se pudo automatizar una captura de pestaña real con `agent-browser` sobre
Chrome for Testing 151 en modo headless. La clave es iniciar el navegador con
`--auto-select-tab-capture-source-by-title=RATORDER-REF`, junto con
`--enable-usermedia-screen-capturing` y `--allow-http-screen-capture`. Así
`getDisplayMedia` elige la pestaña de referencia sin abrir el selector nativo;
el resto del flujo (elegir fuente, grabar, detener y extraer el MP4 de OPFS) se
controla por la UI de Ratorder.

**Hallazgo:** con las opciones anteriores, Chrome entrega la pista de audio de
pestaña con `channelCount: 1`, `echoCancellation: true`,
`noiseSuppression: true` y `autoGainControl: true`. No es audio nativo: el
navegador lo procesa y lo convierte a mono. Al solicitar
`echoCancellation/noiseSuppression/autoGainControl: false`, la pista pasó a
2 canales y los tres indicadores a `false`. No hizo falta forzar
`channelCount: 2`; con el procesamiento desactivado, Chrome conserva el audio
de la pestaña en estéreo. Ese cambio se aplicó en `selectSource`.

**Prueba estéreo:** referencia de 640×360/30 fps con destellos y L=1 kHz,
R=2 kHz. La grabación de 13,2 s resultó Opus 48 kHz estéreo; el canal izquierdo
conservó 1 kHz y el derecho 2 kHz, sin tonos cruzados medibles. En una prueba
de 39 s los eventos de audio aparecieron entre 7,5 ms después y 22,5 ms antes
del video (deriva −30 ms); una repetición dio −10 ms de deriva. La ruta por
defecto (mono/procesada) dio +25 ms de media y −5 ms de deriva en 39 s. Son
pocas muestras y el offset absoluto depende del inicio de captura; no se debe
concluir una deriva estable. Queda pendiente corregir la deriva de reloj de
audio si se exige sincronía de decenas de ms en grabaciones largas.

Artefactos: `artifacts/ref-test.html`, las dos referencias y las grabaciones
`recording-agent-browser-long*.mp4`. `npm test` incluye una regresión que exige
las tres restricciones de audio.
