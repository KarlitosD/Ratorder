# UI de Ratorder — estado y reglas

La refinación visual está completada. Este documento sirve para mantener la interfaz coherente en futuras iteraciones.

## Dirección

Ratorder debe sentirse como un **instrumento de grabación preciso y tranquilo**, no como un dashboard genérico.

- Una sola superficie de trabajo, dividida internamente en vista previa y configuración.
- El motivo propio es el **marco de captura de cuatro esquinas** con un pequeño cuadrado central.
- Menos adornos, menos contenedores y una jerarquía tipográfica clara.
- La acción principal de cada estado debe ser evidente.

## Reglas

1. No tocar `src/lib/recording/` ni `src/lib/storage/` para cambios visuales.
2. Mantener los tokens de `src/app.css`:
   - Azul: `#4F7CF7`
   - Fondo: `#0E1015`
   - Superficie: `#171A21`
   - Bordes: `#292D36`
3. Inter para la interfaz. Geist Mono solo para tiempo y datos.
4. No añadir:
   - Gradientes decorativos.
   - `backdrop-filter` ornamental.
   - Ilustraciones genéricas de ventanas.
   - Cuadrículas de puntos de relleno.
   - Eyebrows sobre títulos.
   - Tarjetas dentro de tarjetas.
5. Mantener el texto secundario con contraste suficiente. El azul de texto de acciones en tema claro usa `--primary-ink`.
6. El botón primario usa `--primary-contrast` (texto blanco sobre el azul de marca).
7. Todos los desplegables usan `SelectField.svelte`. No usar `<select>` nativos: Vivaldi y otros navegadores imponen menús claros y rompen el tema.
8. Cada componente debe conservar sus estados hover, foco, disabled, carga y error.

## Estructura visual actual

- **Header:** marca con marco de captura, navegación textual con subrayado azul, almacenamiento cuando existe y selector de tema.
- **Grabar:** workspace único con borde exterior.
  - Vista previa a la izquierda.
  - Configuración a la derecha, separada por una línea.
  - Estado vacío editorial a dos columnas con el marco de captura.
  - Temporizador en Geist Mono.
  - Detener con tratamiento rojo suave.
- **Biblioteca:** título y contador directos, búsqueda y ordenación, tarjetas de grabación sin sombras pesadas.
  - Estado vacío con el mismo marco de captura.
  - Un solo CTA cuando la biblioteca está vacía.
- **Modal de grabación:** reproductor, datos y acciones; sin blur decorativo.
- **Editor:** una sola superficie con zonas divididas por bordes.
  - Cabecera: volver, título, estado de guardado, botón Guardar y menú de opciones (descartar, restablecer original, atajos).
  - Preview editorial a la izquierda, sin marcos internos decorativos; el lienzo mantiene la relación de aspecto y se escala con `object-fit: contain`.
  - Inspector a la derecha separado por una línea; se apila debajo del preview en pantallas estrechas. El segmento muestra velocidad y volumen; las acciones de dividir, silenciar y eliminar viven en la barra sobre la timeline y en el menú contextual, no duplicadas aquí.
  - Barra de acciones justo encima de la timeline: transporte (fotograma anterior, play/pausa, fotograma siguiente), tiempo mono, deshacer/rehacer, dividir, silenciar, eliminar, importar, añadir y exportar.
  - Timeline inferior con regla mono, pista de video, pista de audio con waveform RMS, pista de elementos con carriles para solapamientos, playhead azul y zoom.
  - Menú contextual propio con clic derecho sobre clips, elementos, timeline y preview.
  - Diálogos de exportación, cambios sin guardar, restablecer/descartar y atajos; sin blur ornamental.

## Notas técnicas

- La previsualización solo debe asignar `video.srcObject` cuando cambie el `MediaStream`. No limpiar ni reasignar el stream en cada actualización del temporizador.
- El audio del sistema se codifica directamente si es la única fuente. Si hay micrófono, se mezcla con Web Audio y se limita antes de codificar.
- No forzar `transform.numberOfChannels` ni `transform.sampleRate` en la fuente de audio de Mediabunny: el remuestreo puede convertir variaciones de timestamps de captura en cortes y solapamientos. Conservar el formato nativo de la pista. `npm test` verifica el sonido decodificado, no solo la presencia de audio.
- Mantener los desplegables propios: los menús nativos de Vivaldi y otros navegadores rompen el tema.
- El preview del editor usa elementos `<video>` ocultos para decodificar y reproducir audio (máximo 3 cargados con LRU); la composición visual pasa siempre por `compositor.ts`. La exportación corre en `export.worker.ts` con `OffscreenCanvas`, WebCodecs y escritura directa a OPFS, con los mismos overlays y sin segunda interpretación del proyecto.
- El volumen por segmento se aplica con una `GainNode` de Web Audio en el preview (permite hasta 150 %) y con ganancia PCM antes de codificar en la exportación. El silencio rápido se mantiene independiente del nivel; subir el volumen de un segmento silenciado lo reactiva.
- La pista de audio decodifica con `AudioSampleSink` (sin `AudioBuffer`) y reduce a bins RMS (máximo 20.000) sin conservar el PCM completo. La caché `recordings/<id>/edit/waveforms/*.bin` evita redecodificar al reabrir; la cola analiza como máximo 2 medios a la vez con prioridad a la fuente. Se dibuja en canvas por clip visible y se atenúa visualmente con mute/volumen; los silencios quedan sin barras.
- La velocidad de preview (0.25×/0.5×/1×/2×) escala el reloj y el `playbackRate` del `<video>`; no modifica el modelo del proyecto ni la exportación. El scheduler del preview limita el canvas a los FPS del proyecto y coalesca ediciones concurrentes.
- No se usa WASM ni WebGPU en esta iteración: composición 2D simple y WSOLA optimizado en JS. WASM queda como posible optimización futura de WSOLA si el perfil lo justifica.
- El lienzo del preview se dibuja a una longitud máxima de 1280 px y se escala con `object-fit: contain`; el hit-testing de overlays descuenta las barras del `contain` para que arrastrar y redimensionar coincida con lo que se ve.
- El proyecto **no se autoguarda**. La cabecera muestra "Cambios sin guardar" y solo se escribe en OPFS al pulsar Guardar. Al cerrar con cambios pendientes se ofrece Guardar y salir, Salir sin guardar o Cancelar; también existe Descartar cambios y Restablecer original.
- Los atajos globales no se ejecutan mientras hay un diálogo abierto o el foco está en un campo de texto. Ctrl/Cmd+S guarda y Ctrl/Cmd+E abre la exportación.
- El menú contextual debe cerrarse con clic fuera, Escape, scroll o resize, y posicionarse dentro del viewport.
- No se edita mientras hay una captura activa: el editor se bloquea para no competir por CPU/disco con la grabación.
- En la exportación, el progreso nunca retrocede y la cancelación elimina la copia parcial. El original queda intacto.
- Los cortes contiguos del preview continúan sobre el mismo elemento `<video>` sin volver a buscar ni reiniciar; los cambios a otro medio se precargan cuando faltan menos de 800 ms. Evitar introducir seeks forzados en cada frontera de clip.

## Archivos principales

```text
src/app.css
src/App.svelte
src/lib/components/AppHeader.svelte
src/lib/components/RecordView.svelte
src/lib/components/SettingsPanel.svelte
src/lib/components/LibraryView.svelte
src/lib/components/RecordingDetail.svelte
src/lib/components/SelectField.svelte
src/lib/components/Toast.svelte
src/lib/components/EditorView.svelte
src/lib/components/editor/EditorToolbar.svelte
src/lib/components/editor/EditorActionBar.svelte
src/lib/components/editor/PreviewStage.svelte
src/lib/components/editor/Timeline.svelte
src/lib/components/editor/Inspector.svelte
src/lib/components/editor/ExportDialog.svelte
src/lib/components/editor/ContextMenu.svelte
src/lib/components/editor/ConfirmDialog.svelte
src/lib/components/editor/UnsavedChangesDialog.svelte
src/lib/components/editor/KeyboardShortcutsDialog.svelte
src/lib/editor/compositor.ts
public/icon.svg
public/favicon.svg
```

## Verificación

```bash
npm run check
npm run build
```

Probar en navegador:

- 1440 × 1000: estados vacío, fuente seleccionada, grabando, completado y biblioteca.
- 390 × 844: grabación, biblioteca y editor.
- Tema oscuro y claro.
- Grabar, pausar, reanudar, silenciar, detener, reproducir, renombrar, exportar y eliminar.
- Editor: abrir desde biblioteca y al detener; reproducir; añadir texto/forma/imagen; mover y
  redimensionar; dividir, recortar, silenciar, cambiar velocidad y volumen; comprobar la
  waveform y localizar un silencio; probar el preview a 0.25×/0.5×; deshacer/rehacer con botones
  y con Ctrl/Cmd+Z; menú contextual con clic derecho; barra de acciones sobre la timeline;
  comprobar que los cambios no se guardan solos, guardar con el botón y Ctrl/Cmd+S, salir sin
  guardar, descartar cambios y restablecer original; abrir el diálogo de atajos con `?`;
  recargar y comprobar que se restaura la última versión guardada; exportar y ver la copia en
  la biblioteca; cancelar una exportación y comprobar que no queda una copia parcial.

Comprobación mecánica de diseño:

```bash
/home/karlitosd/.config/opencode/skills/impeccable/scripts/impeccable detect --json src/app.css src/App.svelte src/lib/components/AppHeader.svelte src/lib/components/RecordView.svelte src/lib/components/SettingsPanel.svelte src/lib/components/LibraryView.svelte src/lib/components/RecordingDetail.svelte src/lib/components/SelectField.svelte src/lib/components/Toast.svelte src/lib/components/EditorView.svelte src/lib/components/editor/EditorToolbar.svelte src/lib/components/editor/EditorActionBar.svelte src/lib/components/editor/PreviewStage.svelte src/lib/components/editor/Timeline.svelte src/lib/components/editor/Inspector.svelte src/lib/components/editor/ExportDialog.svelte src/lib/components/editor/ContextMenu.svelte src/lib/components/editor/ConfirmDialog.svelte src/lib/components/editor/UnsavedChangesDialog.svelte src/lib/components/editor/KeyboardShortcutsDialog.svelte
```

Último resultado: sin hallazgos.
