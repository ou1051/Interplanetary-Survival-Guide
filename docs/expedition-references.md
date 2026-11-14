# Expedition references and verification

## Design research

- ASTEREORRY, NASA Space Apps Challenge 2024, https://github.com/InushaDeSilva/NASA-Space-Apps-Challenge-2024 — interactive orbital exploration as an introduction to a science task.
- Martian Map, https://github.com/RISHI-1453/NASA_Space-Apps_Challenge_Martian_Map — inspectable Mars terrain and explicit separation of source imagery and simulation.
- Starship Mars Transit, https://github.com/SaraMarubel/starship-mars-transit — staged Earth/Mars camera journey, cabin/exterior perspectives, and honest kinematic-flight labels.
- SOL, https://github.com/CKret/SOL-Solar-System-Simulation — cinematic introduction and responsive exploration controls.

These repositories informed the interaction approach. No implementation code was copied. The new ship, camera path, atmosphere and scene lifecycle are original.

## Included asset

`public/journey/earth_day_4096.jpg` is the 4096-pixel Earth texture from https://github.com/mrdoob/three.js/blob/dev/examples/textures/planets/earth_day_4096.jpg. The upstream three.js MIT license is included beside it. The flight's Mars globe is illustrative geometry. Existing mission-map sources and credits continue to identify NASA imagery and elevation.

## Experience

First-time visitors board a transfer spacecraft before mission planning. This is an explicitly compressed flight preview, so scouting/rehearsal still precede the final launch decision. The approved-launch transition also uses the 3D flight sequence. Escape and Skip finish once; playback pauses in a hidden tab; reduced-motion users advance manually. The renderer is reused and its original dimensions/pixel ratio restored after the sequence.

The integrated planning screen shows the host's routes and pins on the 3D globe, with the existing Scout/Plan controls overlaid. Its 2D fallback remains available when WebGL globe initialization fails. Rehearsal terrain and weather remain simulated. This work does not certify the project as competition-ready: real site-pack alignment, LLM weather and full playthrough/performance checks still require completion.
