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

## Notas técnicas

- La previsualización solo debe asignar `video.srcObject` cuando cambie el `MediaStream`. No limpiar ni reasignar el stream en cada actualización del temporizador.
- El audio del sistema se codifica directamente si es la única fuente. Si hay micrófono, se mezcla con Web Audio y se limita antes de codificar.
- No forzar `transform.numberOfChannels` ni `transform.sampleRate` en la fuente de audio de Mediabunny: el remuestreo puede convertir variaciones de timestamps de captura en cortes y solapamientos. Conservar el formato nativo de la pista. `npm test` verifica el sonido decodificado, no solo la presencia de audio.
- Mantener los desplegables propios: los menús nativos de Vivaldi y otros navegadores rompen el tema.

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
- 390 × 844: grabación y biblioteca.
- Tema oscuro y claro.
- Grabar, pausar, reanudar, silenciar, detener, reproducir, renombrar, exportar y eliminar.

Comprobación mecánica de diseño:

```bash
/home/karlitosd/.config/opencode/skills/impeccable/scripts/impeccable detect --json src/app.css src/App.svelte src/lib/components/AppHeader.svelte src/lib/components/RecordView.svelte src/lib/components/SettingsPanel.svelte src/lib/components/LibraryView.svelte src/lib/components/RecordingDetail.svelte src/lib/components/SelectField.svelte src/lib/components/Toast.svelte
```

Último resultado: sin hallazgos.
