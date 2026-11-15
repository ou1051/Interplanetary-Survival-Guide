// ---------------------------------------------------------------------------
// Realistic 3D Mars for the Site Topology console.
//
// A small WebGL renderer (no three.js scene needed): one full-screen quad whose fragment shader
// ray-casts a sphere in orthographic view, so the result lines up exactly with the 2D
// overlay's site pins (SiteTopologyWidget._projectLatLon).
//
//   Colour : NASA Viking/MOLA colour mosaic (nasa/NASA-3D-Resources, public domain)
//   Relief : MGS MOLA global DEM, 463 m mosaic resampled to 2048×1024 (NASA/USGS, public domain)
//            → per-pixel bump normals, so craters, Tharsis, Olympus Mons and Valles Marineris
//              catch the low sun near the terminator.
//   Light  : linear-space Lambert with a soft dusty terminator, limb darkening and a thin
//            butterscotch atmosphere that glows on the sunlit limb.
//
// Both maps are equirectangular, longitude −180°…180° left→right, north up.
// ---------------------------------------------------------------------------

/** How far the quad extends beyond the planet's radius (room for the atmosphere). */
export const GLOBE_PAD = 1.1;

const VERT = `
attribute vec2 aPos;
varying vec2 vP;
uniform float uPad;
void main() {
  vP = aPos * uPad;          // disc coordinates: |vP| = 1 on the limb
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vP;
uniform sampler2D uColor;
uniform sampler2D uHeight;
uniform float uLat0;
uniform float uLon0;
uniform vec3  uSun;          // view space, normalised (x right, y up, z to viewer)
uniform float uBump;
uniform float uPx;           // one output pixel in disc units (for edge anti-aliasing)
uniform vec2  uTexel;        // 1 / height-map size

const float PI = 3.14159265359;

vec2 uvOf(float lat, float lon) {
  return vec2(fract((lon + PI) / (2.0 * PI)), 0.5 - lat / PI);
}
float h(vec2 uv) { return texture2D(uHeight, uv).r; }

void main() {
  float r = length(vP);
  vec3 atmos = vec3(0.86, 0.60, 0.42);

  if (r > 1.0) {
    // Thin atmosphere beyond the limb, lit on the day side
    vec2 dir = vP / r;
    float day = clamp(dot(vec3(dir, 0.0), uSun) * 0.8 + 0.35, 0.0, 1.0);
    float glow = exp(-(r - 1.0) * 38.0) * 0.55 * day;
    gl_FragColor = vec4(atmos * glow, glow);
    return;
  }

  vec3 n = vec3(vP, sqrt(max(0.0, 1.0 - r * r)));
  float sL0 = sin(uLat0), cL0 = cos(uLat0);

  // Inverse orthographic projection → planetocentric latitude, east longitude
  float lat = asin(clamp(n.z * sL0 + n.y * cL0, -1.0, 1.0));
  float lon = uLon0 + atan(n.x, n.z * cL0 - n.y * sL0);
  vec2 uv = uvOf(lat, lon);

  // Local frame in view space: north pole of the planet is (0, cosLat0, sinLat0)
  vec3 pole = vec3(0.0, cL0, sL0);
  vec3 east = cross(pole, n);
  float el = length(east);
  east = el > 1e-4 ? east / el : vec3(1.0, 0.0, 0.0);
  vec3 north = cross(n, east);

  // Height gradient from MOLA (east step widens toward the poles)
  float cosLat = max(cos(lat), 0.12);
  vec2 du = vec2(uTexel.x, 0.0);
  vec2 dv = vec2(0.0, uTexel.y);
  float dhE = (h(uv + du) - h(uv - du)) / cosLat;
  float dhN = (h(uv - dv) - h(uv + dv));
  vec3 nb = normalize(n - uBump * (dhE * east + dhN * north));

  // Albedo (sRGB → linear)
  vec3 albedo = pow(texture2D(uColor, uv).rgb, vec3(2.2));

  // Lighting: relief uses the bumped normal, but the day/night split follows the sphere
  float ndlS = dot(n, uSun);
  float ndlB = max(dot(nb, uSun), 0.0);
  float twilight = smoothstep(-0.10, 0.18, ndlS);
  float diffuse = pow(ndlB, 0.9) * twilight;
  vec3 col = albedo * (diffuse * 1.55 + 0.012);

  // Limb: dust along long sight-lines dims the ground and adds haze on the day side
  float mu = n.z;
  float haze = pow(1.0 - mu, 3.0) * 0.55;
  col = mix(col, pow(atmos, vec3(2.2)) * (0.55 * twilight + 0.02), haze);

  // Gentle filmic shoulder, back to sRGB
  col = col / (1.0 + col * 0.35);
  col = pow(col, vec3(1.0 / 2.2));

  float alpha = clamp((1.0 - r) / uPx, 0.0, 1.0);
  gl_FragColor = vec4(col * alpha, alpha);
}`;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Mars globe shader: ${log}`);
  }
  return s;
}

function makeTexture(gl, img) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  // Both maps are power-of-two: wrap in longitude, mipmap for small on-screen sizes
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/**
 * Create the renderer. Resolves to null when WebGL or the textures are unavailable,
 * so the caller can keep its 2D fallback.
 * @param {{ color: string, height: string }} urls
 */
export async function createMarsGlobeRenderer(urls) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true });
  if (!gl) return null;

  let colorImg, heightImg;
  try {
    [colorImg, heightImg] = await Promise.all([loadImage(urls.color), loadImage(urls.height)]);
  } catch {
    return null;
  }

  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (err) {
    console.warn(err);
    return null;
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  gl.activeTexture(gl.TEXTURE0);
  makeTexture(gl, colorImg);
  gl.activeTexture(gl.TEXTURE1);
  makeTexture(gl, heightImg);

  const U = (name) => gl.getUniformLocation(prog, name);
  gl.uniform1i(U('uColor'), 0);
  gl.uniform1i(U('uHeight'), 1);
  gl.uniform1f(U('uPad'), GLOBE_PAD);
  gl.uniform2f(U('uTexel'), 1 / heightImg.naturalWidth, 1 / heightImg.naturalHeight);
  const uLat0 = U('uLat0');
  const uLon0 = U('uLon0');
  const uSun = U('uSun');
  const uBump = U('uBump');
  const uPx = U('uPx');

  // Sun from the upper left and a little in front: about two-thirds of the disc in daylight
  const sun = [-0.62, 0.38, 0.62];
  const sl = Math.hypot(...sun);
  gl.uniform3f(uSun, sun[0] / sl, sun[1] / sl, sun[2] / sl);

  const maxSize = Math.min(gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0], 2048);
  let lastKey = '';

  return {
    canvas,
    /**
     * Draw the planet for a view centred on (lat0, lon0) radians. The returned canvas is
     * square and covers GLOBE_PAD × radius on each side of the centre.
     * @param {number} sizePx output size in device pixels
     */
    render(sizePx, lat0, lon0) {
      const size = Math.max(2, Math.min(Math.round(sizePx), maxSize));
      const key = `${size}|${lat0.toFixed(5)}|${lon0.toFixed(5)}`;
      if (key === lastKey) return canvas;
      if (canvas.width !== size || canvas.height !== size) {
        canvas.width = size;
        canvas.height = size;
      }
      gl.viewport(0, 0, size, size);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uLat0, lat0);
      gl.uniform1f(uLon0, lon0);
      // Relief strength: exaggerated at planet scale so the landforms read from orbit
      gl.uniform1f(uBump, 9.0);
      gl.uniform1f(uPx, (2 * GLOBE_PAD) / size * 1.2);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      lastKey = key;
      return canvas;
    },
    destroy() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
