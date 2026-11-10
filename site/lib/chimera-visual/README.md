# Chimera profile display

`vendor/` copies the actual Chimera 2D anatomy renderer at
`69be4f2c3932a073b89fd1ad202c710adf54641a` from `src/ui/render/` and `src/ui/colors.ts`.
Copyright (c) 2026 Jameson Hodge, MIT. The complete license is in `vendor/LICENSE`.

Local changes: import paths, site font injection, formatting, punctuation, and a camera that
fits the entire crown and back of the head at every width. The vendored modules keep their
upstream indexed-array assumptions, so their original drawing code is excluded from strict
TypeScript checking and lint rules. The adapter, decoder and React lifecycle remain checked.

`trace.ts` decodes the versioned optional airway suffix documented in the root README.
The outlines/grid come straight from the retained Rust `HumanFrame`. `model.ts` only supplies
the original renderer's coordinate transform; it cannot compute or render audio.
The wrapper passes no worklet telemetry, so acoustic particles and pressure overlays stay off.
Articulation, tongue geometry, jaw, lips and velum are the actual playback-time frame.

`Layers` imports the viewer only while its section is visible. Its resize observer and animation
frame are released on unmount. The silent preview is also real engine output, not a text-driven
mouth animation.
