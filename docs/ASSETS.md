# Journey assets and provenance

The launch complex, crew access arm, spacecraft cockpit, gloves, control panels,
Mars planet and landing landscape are original procedural models in
`src/journey/journey.js`. They are educational illustrations, not surveyed geometry.

`public/textures/earth-atmosphere.jpg` is `earth_atmos_2048.jpg` from the
[Three.js examples](https://github.com/mrdoob/three.js/blob/dev/examples/textures/planets/earth_atmos_2048.jpg),
blob `4275ab0836b482e4fbe1d5081976f3f2ffb41ffa`. Resolution: 2048×1024.
It is bundled locally, so the journey does not require a third-party image server.
Three.js distributes its repository under the MIT license, reproduced below.
The app retains an explicitly illustrative procedural fallback if loading fails.

The Mars surface simulation remains synthetic. Orbital map data sources and resolutions
are documented in `src/map/globe/catalog.ts` and `src/map/README.md`.

## Three.js MIT license

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
