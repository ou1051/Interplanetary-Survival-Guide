import * as THREE from 'three';
import { CHAPTERS, DURATION, chapterAt, smooth } from './timeline.js';
import './journey.css';

// Original cinematic scene. Distances and flight time are deliberately compressed.
export function startJourney({ onComplete, renderer, introduction = true }) {
  const previousFocus = document.activeElement;
  const originalParent = renderer.domElement.parentElement;
  const originalRatio = renderer.getPixelRatio();
  const originalSize = renderer.getSize(new THREE.Vector2());
  const root = document.createElement('section');
  root.className = 'journey';
  root.setAttribute('aria-label', 'Earth to Mars flight experience');
  root.innerHTML = `<header><div class="j-brand"><span>Field Office</span> / Freelance Astronaut</div><button data-action="skip">Skip to mission</button></header>
    <div class="j-copy"><p class="j-place"></p><h1></h1><p class="j-description"></p><button class="j-cta" data-action="next">Board spacecraft →</button><p class="j-error" role="status"></p></div>
    <div class="j-controls"><button data-action="view" aria-pressed="false">Cabin view</button><button data-action="pause" aria-pressed="false">Pause</button><label>Quality <select aria-label="Rendering quality"><option value="1">Balanced</option><option value="2" selected>High</option></select></label></div>
    <footer><div class="j-meta"><span>EARTH → MARS / CREW TRANSFER</span><span class="j-time">Ready to board</span></div><div class="j-track"><span>EARTH</span><span>ASCENT</span><span>TRANSFER</span><span>ARRIVAL</span></div>
    <p class="j-note">Compressed, fictional flight ${introduction ? 'preview before mission planning' : 'after launch approval'}. Distances and duration are illustrative. Earth imagery · three.js example texture. Arrival globe · illustrative.</p></footer>`;
  document.body.append(root);
  root.prepend(renderer.domElement);
  const find = selector => root.querySelector(selector);
  const next = find('[data-action="next"]');
  const pause = find('[data-action="pause"]');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let paused = reduced;
  let cabin = false;
  let running = false;
  let elapsed = 0;
  let ended = false;
  let animation;
  let last = performance.now();
  let activeChapter = -1;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#02050b');
  const camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, .01, 300);
  const complete = () => {
    if (ended) return;
    ended = true;
    cancelAnimationFrame(animation);
    window.removeEventListener('resize', resize);
    const geometries = new Set(), materials = new Set();
    scene.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material) materials.add(material);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) { material.map?.dispose(); material.dispose(); }
    originalParent.append(renderer.domElement);
    renderer.setPixelRatio(originalRatio);
    renderer.setSize(originalSize.x, originalSize.y);
    root.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
    onComplete();
  };
  find('[data-action="skip"]').onclick = complete;
  function resize() {
    renderer.setPixelRatio(Math.min(devicePixelRatio, Number(find('select').value)));
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') complete();
    if (event.key !== 'Tab') return;
    const items = [...root.querySelectorAll('button,select')];
    if (event.shiftKey && document.activeElement === items[0]) {
      event.preventDefault(); items.at(-1).focus();
    } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
      event.preventDefault(); items[0].focus();
    }
  });
  function updateChapter(index) {
    if (index === activeChapter) return;
    activeChapter = index;
    const chapter = CHAPTERS[index];
    find('.j-place').textContent = chapter[0];
    find('h1').textContent = chapter[1];
    find('.j-description').textContent = chapter[2];
    next.textContent = index === 0 ? 'Board spacecraft →' : index === 4 ? (introduction ? 'Open mission briefing →' : 'View mission decision →') : 'Next flight phase →';
    [...root.querySelectorAll('.j-track span')].forEach((item, i) => item.classList.toggle('active', i <= Math.min(index,3)));
  }
  updateChapter(0);
  next.focus();
  pause.textContent = paused ? 'Resume' : 'Pause';
  pause.setAttribute('aria-pressed', String(paused));
  pause.onclick = () => {
    paused = !paused;
    pause.textContent = paused ? 'Resume' : 'Pause';
    pause.setAttribute('aria-pressed', String(paused));
  };
  find('[data-action="view"]').onclick = event => {
    cabin = !cabin;
    event.currentTarget.setAttribute('aria-pressed', String(cabin));
    event.currentTarget.textContent = cabin ? 'Exterior view' : 'Cabin view';
  };
  next.onclick = () => {
    if (activeChapter === 4) return complete();
    if (!running) { running = true; elapsed = 0; }
    else elapsed = [0,9,27,DURATION][activeChapter];
    updateChapter(chapterAt(elapsed));
  };
  find('select').onchange = resize;
  resize();
  window.addEventListener('resize', resize);
  scene.add(new THREE.AmbientLight(0x9ab7e8,.7));
  const sun = new THREE.DirectionalLight(0xffead1,3);
  sun.position.set(-12,8,15); scene.add(sun);
  function makePlanet(radius, color, position) {
    const planet = new THREE.Mesh(new THREE.SphereGeometry(radius,128,64),new THREE.MeshStandardMaterial({color,roughness:.9}));
    planet.position.copy(position);
    scene.add(planet);
    return planet;
  }
  const earth = makePlanet(3.4,0x426da3,new THREE.Vector3(-8,0,0));
  const mars = makePlanet(2,0xb56841,new THREE.Vector3(27,1,-6));
  new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}journey/earth_day_4096.jpg`, texture => {
    if (ended) { texture.dispose(); return; }
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8,renderer.capabilities.getMaxAnisotropy());
    earth.material.map = texture; earth.material.color.set(0xffffff); earth.material.needsUpdate = true;
  }, undefined, () => { if (!ended) find('.j-error').textContent = 'Earth imagery unavailable · illustrative globe shown.'; });
  const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(3.49,96,48), new THREE.ShaderMaterial({
    uniforms:{glow:{value:new THREE.Color(0x438ee8)}},
    vertexShader:'varying vec3 n; varying vec3 v; void main(){ vec4 p=modelViewMatrix*vec4(position,1.); n=normalize(normalMatrix*normal); v=normalize(-p.xyz); gl_Position=projectionMatrix*p; }',
    fragmentShader:'uniform vec3 glow; varying vec3 n; varying vec3 v; void main(){float a=pow(1.-abs(dot(normalize(n),normalize(v))),3.);gl_FragColor=vec4(glow,a*.65);}',
    transparent:true,depthWrite:false,blending:THREE.AdditiveBlending
  }));
  atmosphere.position.copy(earth.position); scene.add(atmosphere);
  // Deterministic geometric surface detail; no scientific terrain claim.
  const marsGeometry = mars.geometry;
  const vertices = marsGeometry.attributes.position;
  for (let i=0;i<vertices.count;i++) {
    const p = new THREE.Vector3().fromBufferAttribute(vertices,i);
    const relief = Math.sin(p.x*13)*Math.cos(p.y*17)*Math.sin(p.z*11)*.007;
    p.multiplyScalar(1+relief); vertices.setXYZ(i,p.x,p.y,p.z);
  }
  marsGeometry.computeVertexNormals();
  const stars = new Float32Array(4500*3);
  for (let i=0;i<stars.length;i+=3) {
    const theta=i*2.399963, z=1-2*i/stars.length, radius=Math.sqrt(1-z*z);
    stars[i]=Math.cos(theta)*radius*110; stars[i+1]=z*110; stars[i+2]=Math.sin(theta)*radius*110;
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position',new THREE.BufferAttribute(stars,3));
  scene.add(new THREE.Points(starGeometry,new THREE.PointsMaterial({color:0xc5d9ff,size:.12,sizeAttenuation:true})));
  const ship = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({color:0xd1d9e1,metalness:.65,roughness:.28});
  const dark = new THREE.MeshStandardMaterial({color:0x111c2d,metalness:.5,roughness:.35});
  function part(geometry, material, y) {
    const mesh = new THREE.Mesh(geometry,material); mesh.position.y=y;ship.add(mesh);return mesh;
  }
  part(new THREE.CylinderGeometry(.16,.21,1.5,32),metal,0);
  part(new THREE.ConeGeometry(.16,.4,32),metal,.95);
  part(new THREE.CylinderGeometry(.23,.18,.18,32),dark,-.82);
  for (const side of [-1,1]) {
    const panel=part(new THREE.BoxGeometry(1.05,.025,.55),new THREE.MeshStandardMaterial({color:0x16436e,metalness:.65,roughness:.2}),-.2);
    panel.position.x=side*.7;
    for (let x=0;x<6;x++) {
      const bar=part(new THREE.BoxGeometry(.012,.03,.55),metal,-.2);bar.position.x=side*(.2+x*.2);
    }
  }
  const flame = part(new THREE.ConeGeometry(.16,1.5,24),new THREE.MeshBasicMaterial({color:0x92dfff,transparent:true,opacity:.65,depthWrite:false}),-1.6);
  flame.rotation.z=Math.PI;
  scene.add(ship);
  const cabinFrame = new THREE.Group();
  const cabinMaterial = new THREE.MeshStandardMaterial({color:0x131e2a,metalness:.4,roughness:.6});
  for (const x of [-.9,.9]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(.05,2,.08),cabinMaterial);
    beam.position.set(x,0,-1.6);cabinFrame.add(beam);
  }
  const dashboard = new THREE.Mesh(new THREE.BoxGeometry(2.7,.35,.5),cabinMaterial);
  dashboard.position.set(0,-.8,-1.5);cabinFrame.add(dashboard);
  camera.add(cabinFrame);scene.add(camera);
  const path = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-5.4,2.7,2.3),new THREE.Vector3(-3,5,3),
    new THREE.Vector3(6,5,1),new THREE.Vector3(17,4,-2),new THREE.Vector3(26,3.2,-3)
  ]);
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(path.getPoints(160)),new THREE.LineBasicMaterial({color:0x74aabf,transparent:true,opacity:.25})));
  const target = new THREE.Vector3();
  const desired = new THREE.Vector3();
  function frame(now) {
    if (ended) return;
    const dt=Math.min((now-last)/1000,.05);last=now;
    if (running && !paused && !document.hidden) elapsed=Math.min(DURATION,elapsed+dt);
    if (running) updateChapter(chapterAt(elapsed));
    const progress=running?smooth(elapsed/DURATION):0;
    ship.position.copy(path.getPoint(progress));
    const tangent=path.getTangent(progress);
    ship.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),tangent);
    flame.visible=running && activeChapter !== 4;
    if (!paused && !reduced) flame.scale.y=1+Math.sin(now*.04)*.12;
    cabinFrame.visible=cabin; ship.visible=!cabin;
    if (cabin) {
      camera.position.copy(ship.position).add(new THREE.Vector3(0,.1,.1));
      target.copy(ship.position).addScaledVector(tangent,4);
    } else if (!running) {
      camera.position.set(-1.5,3.5,12);target.set(-6,.4,0);
    } else {
      desired.copy(ship.position).add(new THREE.Vector3(3.5,2.2,7));
      camera.position.lerp(desired,reduced?1:1-Math.exp(-dt*3));
      target.copy(ship.position).addScaledVector(tangent,1.6);
    }
    camera.lookAt(target);
    if (!paused && !reduced) earth.rotation.y+=dt*.022;
    find('.j-time').textContent=running?`Flight preview · ${Math.round(progress*100)}%`:'Ready to board';
    renderer.render(scene,camera);
    animation=requestAnimationFrame(frame);
  }
  animation=requestAnimationFrame(frame);
  return complete;
}
