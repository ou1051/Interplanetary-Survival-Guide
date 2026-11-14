import * as THREE from 'three';
import { createSky, SUN_DIR, HORIZON } from '../world/atmosphere.js';
import { terrainGeometry, heightAt } from './walk.js';

export function createScene(container, { site, route, visibility }) {
  const scene = new THREE.Scene();
  const span = Math.max(site.width, site.height) * site.cellSizeM;
  const camera = new THREE.PerspectiveCamera(70, 1, 0.08, Math.max(2000, span * 4));
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;';
  renderer.domElement.setAttribute('aria-label', 'First-person rehearsal terrain. Station names and recording controls are provided beside this view.');
  container.append(renderer.domElement);

  const sky = createSky();
  sky.scale.setScalar(camera.far / 20);
  scene.add(sky);
  scene.add(new THREE.HemisphereLight(0xf8d6b0, 0x543b2c, 2.1));
  const sun = new THREE.DirectionalLight(0xffe0b8, 2.6);
  sun.position.copy(SUN_DIR).multiplyScalar(100);
  scene.add(sun);
  // Fog affects world surfaces; navigation aids and the surrounding HTML remain legible.
  const fogRange = { clear: [90, 380], hazy: [18, 105], poor: [4, 32] }[visibility];
  scene.fog = new THREE.Fog(HORIZON, ...fogRange);

  const data = terrainGeometry(site);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
  geometry.setIndex(data.indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: 0xbb8965, roughness: 1, side: THREE.DoubleSide });
  let disposed = false;
  if (site.textureUrl) {
    material.map = new THREE.TextureLoader().load(site.textureUrl, (texture) => {
      if (disposed) texture.dispose();
    });
    material.map.colorSpace = THREE.SRGBColorSpace;
    material.color.set(0xffffff);
  }
  scene.add(new THREE.Mesh(geometry, material));

  const routePositions = [];
  for (let index = 1; index < route.cells.length; index++) {
    const from = route.cells[index - 1];
    const to = route.cells[index];
    const dx = (to.col - from.col) * site.cellSizeM;
    const dz = (to.row - from.row) * site.cellSizeM;
    const distance = Math.hypot(dx, dz);
    if (distance === 0) continue;
    const steps = Math.ceil(distance / 0.5);
    for (let step = 0; step < steps; step++) {
      const vertices = [];
      for (const fraction of [step / steps, (step + 1) / steps]) {
        for (const side of [-1, 1]) {
          const x = from.col * site.cellSizeM + dx * fraction - dz / distance * 0.2 * side;
          const z = from.row * site.cellSizeM + dz * fraction + dx / distance * 0.2 * side;
          const y = heightAt(site, x, z);
          if (y !== null) vertices.push(x, y + 0.06, z);
        }
      }
      if (vertices.length !== 12) continue;
      for (const corner of [0, 1, 2, 1, 3, 2]) routePositions.push(...vertices.slice(corner * 3, corner * 3 + 3));
    }
  }
  const routeGeometry = new THREE.BufferGeometry();
  routeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(routePositions, 3));
  scene.add(new THREE.Mesh(routeGeometry, new THREE.MeshBasicMaterial({ color: 0x96dfc3, side: THREE.DoubleSide })));

  const markers = [];
  const places = [{ id: 'base', name: 'BASE · fictional', cell: site.base }, ...site.stations];
  for (const [index, place] of places.entries()) {
    const x = place.cell.col * site.cellSizeM;
    const z = place.cell.row * site.cellSizeM;
    const y = heightAt(site, x, z);
    if (y === null) continue;
    const group = new THREE.Group();
    group.position.set(x, y, z);
    const color = index === 0 ? 0xc7f0ff : index === 1 ? 0xffb75e : 0xb5b1ff;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 3, 8), new THREE.MeshBasicMaterial({ color, fog: false }));
    pole.position.y = 1.5;
    const flag = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.45, 0.08), pole.material);
    flag.position.set(0.42, 2.7, 0);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.045, 6, 48), pole.material);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.12;
    group.add(pole, flag, ring);

    const label = document.createElement('canvas');
    label.width = 768;
    label.height = 96;
    const context = label.getContext('2d');
    context.fillStyle = 'rgba(14, 20, 23, 0.88)';
    context.fillRect(0, 0, label.width, label.height);
    context.fillStyle = '#fff7e9';
    context.font = 'bold 32px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(index === 0 ? place.name : `${index} · ${place.name}`, 384, 48, 740);
    const texture = new THREE.CanvasTexture(label);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, fog: false, depthTest: false }));
    sprite.position.y = 3.7;
    sprite.scale.set(7.2, 0.9, 1);
    group.add(sprite);
    group.userData.stationId = place.id;
    group.userData.color = color;
    markers.push(group);
    scene.add(group);
  }

  const resize = new ResizeObserver(() => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  });
  resize.observe(container);

  return {
    render(walk, heading) {
      const elevation = heightAt(site, walk.x, walk.z);
      camera.position.set(walk.x, elevation + 1.7, walk.z);
      camera.lookAt(walk.x + Math.sin(heading), camera.position.y - 0.08, walk.z - Math.cos(heading));
      sky.position.copy(camera.position);
      for (const marker of markers) {
        const observed = walk.observedStationIds.includes(marker.userData.stationId);
        marker.children[0].material.color.set(observed ? 0x78ffc1 : marker.userData.color);
      }
      renderer.render(scene, camera);
    },
    dispose() {
      disposed = true;
      resize.disconnect();
      const geometries = new Set();
      const materials = new Set();
      const textures = new Set();
      scene.traverse((object) => {
        if (object.geometry) geometries.add(object.geometry);
        if (object.material) materials.add(object.material);
        if (object.material?.map) textures.add(object.material.map);
      });
      for (const texture of textures) texture.dispose();
      for (const material of materials) material.dispose();
      for (const geometry of geometries) geometry.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
