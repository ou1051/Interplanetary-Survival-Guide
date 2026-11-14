import * as THREE from 'three';
import { mulberry32 } from '../core/math.js';

function materialTexture(renderer, colors, panels = false) {
  const tile = document.createElement('canvas');
  tile.width = tile.height = 256;
  const ctx = tile.getContext('2d');
  const random = mulberry32(92);
  ctx.fillStyle = colors[0];
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    ctx.globalAlpha = random() * .11;
    ctx.fillStyle = colors[i % 2 + 1];
    ctx.fillRect(random() * 256, random() * 256, panels ? random() * 4 + 1 : random() * 7 + 1, random() * 2 + 1);
  }
  ctx.globalAlpha = 1;
  if (panels) {
    ctx.strokeStyle = '#1f1c19';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, 253, 253);
    ctx.strokeStyle = '#ffffff30';
    ctx.lineWidth = 1;
    ctx.strokeRect(5, 5, 246, 246);
    for (const x of [13, 243]) for (const y of [13, 243]) {
      ctx.fillStyle = '#201b17';
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  const map = new THREE.CanvasTexture(tile);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return map;
}

export function mountHabitatRoom(canvas, onScreen) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.65));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.23;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#de9461');
  scene.fog = new THREE.FogExp2('#ca805d', .009);
  const camera = new THREE.PerspectiveCamera(42, 1, .1, 170);
  camera.position.set(0, 2.55, 8.5);

  const panels = materialTexture(renderer, ['#56616b', '#b3c1c7', '#29353b'], true);
  const steel = materialTexture(renderer, ['#404f5b', '#a7b7c0', '#1b2930']);
  const dust = materialTexture(renderer, ['#a46642', '#d69c5d', '#4d2f22']);
  dust.repeat.set(20, 20);
  const wall = new THREE.MeshStandardMaterial({ map: panels, roughness: .8, metalness: .19 });
  const trim = new THREE.MeshStandardMaterial({ map: steel, roughness: .48, metalness: .38 });
  const dark = new THREE.MeshStandardMaterial({ color: '#19252c', roughness: .72 });
  const enamel = new THREE.MeshStandardMaterial({ color: '#a6a6a0', metalness: .22, roughness: .54, map: steel });
  const padding = new THREE.MeshStandardMaterial({ color: '#23323c', roughness: .88 });
  const light = new THREE.MeshStandardMaterial({ color: '#aee7f6', emissive: '#a8edff', emissiveIntensity: 1.4 });
  const orange = new THREE.MeshStandardMaterial({ color: '#b36b34', emissive: '#ff9e4c', emissiveIntensity: 2 });
  const cyan = new THREE.MeshStandardMaterial({ color: '#448085', emissive: '#559fa8', emissiveIntensity: .85 });
  const rock = new THREE.MeshStandardMaterial({ map: dust, roughness: 1, flatShading: true });
  function mesh(geometry, material, x, y, z) {
    const object = new THREE.Mesh(geometry, material);
    object.position.set(x, y, z);
    scene.add(object);
    return object;
  }
  function box(w, h, d, x, y, z, material = wall) {
    return mesh(new THREE.BoxGeometry(w, h, d), material, x, y, z);
  }

  scene.add(new THREE.HemisphereLight('#e6f4ff', '#384553', 1.32));
  const sun = new THREE.DirectionalLight('#ffc492', 2.5);
  sun.position.set(-5, 7, -8);
  scene.add(sun);
  const fill = new THREE.PointLight('#b3d9ff', 35, 13);
  fill.position.set(2, 4, 5);
  scene.add(fill);

  const bounce = new THREE.PointLight('#ffa14b', 11, 5);
  bounce.position.set(-3.8, 2.65, 2.8);
  scene.add(bounce);
  const consoleLight = new THREE.PointLight('#66cdff', 15, 6);
  consoleLight.position.set(2.3, 2.8, 2.85);
  scene.add(consoleLight);

  // Pressure hull: rolled panels between transverse ribs, open toward the windows.
  const hullRadius = 6.9;
  const hullDepth = 11;
  const hull = new THREE.CylinderGeometry(hullRadius, hullRadius, hullDepth, 40, 1, true, Math.PI * .22, Math.PI * 1.56);
  hull.rotateY(Math.PI / 2);
  hull.rotateX(Math.PI / 2);
  wall.side = THREE.DoubleSide;
  mesh(hull, wall, 0, -1.12, 3.9);
  for (const z of [.45, 3.25, 6.2]) {
    const shape = new THREE.TorusGeometry(6.46, .19, 8, 42, Math.PI * .89);
    shape.rotateZ(Math.PI * .055);
    mesh(shape, trim, 0, -1.24, z);
  }
  for (const x of [-5.3, 5.3]) {
    box(.15, .09, 8, x, 2.0, 4.1, dark);
    box(.035, .026, 7.6, x, 2.04, 4, light);
  }
  for (let i = -3; i <= 3; i++) {
    const x = i * 1.72;
    box(1.70, .17, 10.7, x, -.13, 4.2, dark);
    box(.032, .016, 10.5, x + .79, -.033, 4.1, trim);
  }
  for (const x of [-2.1, 2.1]) {
    const housing = box(.21, .18, 5.8, x, 4.77, 3.14, trim);
    housing.rotation.z = -.075 * Math.sign(x);
    box(.115, .052, 5.2, x, 4.655, 3, light);
  }

  function octagon(width, height, chamfer) {
    const x = width / 2, y = height / 2;
    return [[-x + chamfer, -y], [x - chamfer, -y], [x, -y + chamfer],
      [x, y - chamfer], [x - chamfer, y], [-x + chamfer, y], [-x, y - chamfer], [-x, -y + chamfer]];
  }

  function frame(outer, inner, depth, x, y, z, material) {
    const points = (corners) => octagon(...corners).map(([px, py]) => new THREE.Vector2(px, py));
    const shape = new THREE.Shape(points(outer));
    shape.holes.push(new THREE.Path(points(inner).reverse()));
    return mesh(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }), material, x, y, z);
  }

  const displayMaps = [];
  function terminal(x, y, z, label, value, color, yaw) {
    const tile = document.createElement('canvas');
    tile.width = 384;
    tile.height = 224;
    const ctx = tile.getContext('2d');
    ctx.fillStyle = '#061318';
    ctx.fillRect(0, 0, 384, 224);
    ctx.strokeStyle = '#335460';
    for (let column = 16; column < 370; column += 22) ctx.strokeRect(column, 88, 0.8, 100);
    for (let row = 88; row < 198; row += 20) ctx.strokeRect(16, row, 352, 0.8);
    ctx.fillStyle = color;
    ctx.font = '19px monospace';
    ctx.fillText(label, 17, 35);
    ctx.font = 'bold 29px monospace';
    ctx.fillText(value, 17, 70);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.8;
    ctx.beginPath();
    for (let i = 0; i <= 22; i++) {
      const sample = 161 - Math.sin(i * .47 + yaw) * 19 - Math.sin(i * 1.66) * 8 - i * .83;
      if (i === 0) ctx.moveTo(17, sample);
      else ctx.lineTo(17 + i * 15.8, sample);
    }
    ctx.stroke();
    ctx.font = '14px monospace';
    ctx.fillText('SIMULATION TELEMETRY', 17, 211);
    const map = new THREE.CanvasTexture(tile);
    map.colorSpace = THREE.SRGBColorSpace;
    displayMaps.push(map);

    const mount = new THREE.Group();
    mount.position.set(x, y, z);
    mount.rotation.set(-.19, yaw, 0);
    scene.add(mount);
    function part(geometry, material, px, py, pz) {
      const object = new THREE.Mesh(geometry, material);
      object.position.set(px, py, pz);
      mount.add(object);
      return object;
    }
    part(new THREE.BoxGeometry(1.84, 1.25, .29), enamel, 0, 0, 0);
    part(new THREE.BoxGeometry(1.66, .89, .09), dark, 0, .13, .15);
    part(new THREE.PlaneGeometry(1.43, .78), new THREE.MeshBasicMaterial({ map }), 0, .14, .206);
    for (let row = 0; row < 2; row++) for (let col = 0; col < 7; col++) {
      part(new THREE.BoxGeometry(.105, .07, .065), row === 1 && col % 3 === 0 ? orange : col % 4 === 0 ? cyan : trim,
        -.69 + col * .17, -.39 - row * .115, .18);
    }
    for (const knobY of [-.35, -.51]) {
      part(new THREE.CylinderGeometry(.066, .072, .065, 12), dark, .65, knobY, .20).rotation.x = Math.PI / 2;
      part(new THREE.BoxGeometry(.015, .045, .025), light, .65, knobY + .012, .246);
    }
  }

  for (const sign of [-1, 1]) {
    const x = sign * 4.43;
    const y = 2.9;
    box(4.55, 1.25, .31, x, .6, -.25, wall);
    frame([4.48, 4.26, .22], [3.36, 2.18, .38], .31, x, y, -.25, wall);
    frame([3.73, 2.55, .48], [3.30, 2.11, .37], .34, x, y, .07, trim);
    frame([3.37, 2.19, .39], [3.18, 2, .34], .12, x, y, .39, dark);
    frame([3.85, 2.67, .50], [3.71, 2.53, .47], .055, x, y, .39, enamel);
    const glass = new THREE.MeshBasicMaterial({ color: '#cce7ff', transparent: true, opacity: .07, depthWrite: false });
    const pane = octagon(3.18, 2, .34).map(([px, py]) => new THREE.Vector2(px, py));
    mesh(new THREE.ShapeGeometry(new THREE.Shape(pane)), glass, x, y, .38);
    const glare = box(2.12, .014, .012, x, y + .64, .46, glass);
    glare.rotation.z = -sign * .23;

    terminal(sign * 3.38, 1.57, 1.77,
      sign < 0 ? 'ATMOSPHERE' : 'SURFACE COMMS',
      sign < 0 ? '−35 °C' : 'RELAY READY',
      sign < 0 ? '#ffbd73' : '#92e8fa', -sign * .29);
    const sideStrip = box(.052, 1.13, .08, sign * 3.0, 3.57, .74, orange);
    sideStrip.rotation.z = -sign * .32;
    const floorStrip = box(.045, .035, 3.72, sign * 1.53, .01, 4.18, cyan);
    floorStrip.rotation.y = sign * .12;
    for (let slot = 0; slot < 5; slot++) {
      box(.32, .028, .041, sign * 3.74, .75 + slot * .068, .40, dark);
    }

    // Paired flight stations with keypad, displays, and restrained crew seats.
    const wing = box(1.68, .24, 1.15, sign * 3.57, 1.47, 1.17, trim);
    wing.rotation.x = -.23;
    const glassPanel = box(1.34, .042, .48, sign * 3.57, 1.62, .94, dark);
    glassPanel.rotation.x = -.23;
    for (let row = 0; row < 4; row++) {
      box(.28 + row * .09, .022, .023, sign * 3.48, 1.69 - row * .018, .78 + row * .07, cyan);
    }
    box(.93, .19, .92, sign * 2.68, .60, 3.28, padding);
    const seat = box(.86, 1.12, .25, sign * 2.68, 1.19, 3.71, padding);
    seat.rotation.x = -.18;
    box(.58, .32, .3, sign * 2.68, 1.86, 3.83, padding);
    for (const offset of [-.34, .34]) {
      box(.055, 1.02, .024, sign * 2.68 + offset, 1.22, 3.86, orange);
    }
    box(.44, .52, .47, sign * 2.68, .27, 3.34, trim);
  }

  // The HTML console is aligned to the front face of this physical monitor.
  const screen = { x: 0, y: 2.92, z: 1.16, width: 4.62, height: 2.46 };
  box(5.06, 2.9, .72, 0, screen.y, .63, trim);
  box(4.79, 2.63, .24, 0, screen.y, 1, dark);
  for (const x of [-2.41, 2.41]) for (const y of [1.6, 4.24]) {
    mesh(new THREE.CylinderGeometry(.065, .065, .028, 6), dark, x, y, 1.03).rotation.x = Math.PI / 2;
  }
  box(5.22, .31, 1.71, 0, 1.48, 1.71, trim).rotation.x = -.15;
  box(4.8, .96, .95, 0, .74, 1.48, dark);
  box(4.73, .07, .09, 0, 1.27, 2.48, dark);
  const instruments = document.createElement('canvas');
  instruments.width = 768;
  instruments.height = 128;
  const panel = instruments.getContext('2d');
  panel.fillStyle = '#09191f';
  panel.fillRect(0, 0, 768, 128);
  for (const [i, label] of ['SUIT TELEMETRY', 'HABITAT SYSTEMS', 'ROVER LINK'].entries()) {
    const x = i * 256 + 12;
    panel.strokeStyle = '#376774';
    panel.strokeRect(x, 7, 232, 111);
    panel.fillStyle = '#9ee6f3';
    panel.font = '14px monospace';
    panel.fillText(label, x + 10, 29);
    for (let row = 0; row < 4; row++) {
      panel.fillStyle = row === 3 ? '#e3a06a' : '#5499a6';
      panel.fillRect(x + 11, 44 + row * 14, 107 + (i * 17 + row * 27) % 85, 3);
    }
  }
  const instrumentMap = new THREE.CanvasTexture(instruments);
  instrumentMap.colorSpace = THREE.SRGBColorSpace;
  box(4.6, .78, .10, 0, .85, 2.015, trim);
  mesh(new THREE.PlaneGeometry(4.44, .66), new THREE.MeshBasicMaterial({ map: instrumentMap }), 0, .85, 2.072);
  for (const x of [-1.92, -.96, 0, .96, 1.92]) {
    box(.76, .12, .49, x, 1.66, 1.94, dark);
    box(.61, .035, .09, x, 1.73, 1.82, x === 0 ? orange : cyan);
    for (const offset of [-.18, 0, .18]) {
      mesh(new THREE.CylinderGeometry(.052, .064, .09, 10), trim, x + offset, 1.75, 2.03);
    }
  }

  const ground = mesh(new THREE.PlaneGeometry(240, 180), rock, 0, -.28, -60);
  ground.rotation.x = -Math.PI / 2;
  const random = mulberry32(38);
  const ridgeShape = new THREE.DodecahedronGeometry(1, 0);
  const ridgeMaterial = new THREE.MeshStandardMaterial({ color: '#875439', map: dust, flatShading: true, roughness: 1 });
  const ridgeGeometry = new THREE.PlaneGeometry(160, 48, 72, 24);
  ridgeGeometry.rotateX(-Math.PI / 2);
  const vertices = ridgeGeometry.attributes.position;
  for (let i = 0; i < vertices.count; i++) {
    const x = vertices.getX(i);
    const z = vertices.getZ(i);
    const ridgeline = Math.exp(-((z + 5) ** 2) / 82);
    const height = ridgeline * (4 + 1.8 * Math.sin(x * .14) + Math.sin(x * .52) * .65 + random() * .65);
    vertices.setY(i, height);
  }
  ridgeGeometry.computeVertexNormals();
  mesh(ridgeGeometry, ridgeMaterial, 0, -.24, -57);
  for (let i = 0; i < 90; i++) {
    const boulder = mesh(ridgeShape, ridgeMaterial, (random() - .5) * 40, -.22, -2 - random() * 36);
    const size = .11 + random() ** 3 * .57;
    boulder.scale.set(size, size * .6, size * 1.5);
  }
  // Parked rover silhouette, visible through the right observation window.
  const wheel = new THREE.CylinderGeometry(.33, .33, .18, 16);
  for (const x of [5.9, 7.23]) for (const z of [-6.4, -7.6]) {
    mesh(wheel, dark, x, .12, z).rotation.z = Math.PI / 2;
    box(.09, .87, .09, x, .7, z, trim);
  }
  box(1.4, .21, 1.56, 6.56, .39, -7, trim);
  box(1.5, .11, 1.57, 6.56, 1.16, -7, trim);
  box(.25, .13, .06, 6.8, .53, -6.18, orange);

  // 0 = standing back in the room, 1 = leaning in to the console monitor
  let dolly = 0;
  function draw() {
    const { clientWidth: width, clientHeight: height } = canvas;
    if (!width || !height) return;
    camera.position.set(0, 2.55 + 0.22 * dolly, 8.5 - 2.4 * dolly);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Fit the monitor at narrow widths and retain the room around it on wide displays.
    const verticalFov = camera.aspect < 1.45 ? Math.min(82, 42 * 1.45 / camera.aspect) : 42;
    camera.fov = verticalFov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const project = (x, y) => new THREE.Vector3(x, y, screen.z).project(camera);
    const tl = project(screen.x - screen.width / 2, screen.y + screen.height / 2);
    const br = project(screen.x + screen.width / 2, screen.y - screen.height / 2);
    onScreen({ left: (tl.x + 1) * 50, top: (1 - tl.y) * 50,
      width: (br.x - tl.x) * 50, height: (tl.y - br.y) * 50 });
    renderer.render(scene, camera);
  }
  const resize = new ResizeObserver(draw);
  resize.observe(canvas);
  draw();
  return {
    draw,
    setDolly(value) {
      dolly = value;
      draw();
    },
    dispose() {
      resize.disconnect();
      const resources = new Set([panels, steel, dust, instrumentMap, ...displayMaps]);
      scene.traverse(object => {
        if (object.isMesh) {
          resources.add(object.geometry);
          resources.add(object.material);
        }
      });
      for (const resource of resources) resource.dispose();
      renderer.dispose();
    },
  };
}
