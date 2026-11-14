// Render the actual rover route and stops over elevation sampled from its terrain.
export function makeDeltaOverview(route, width, height, approaches, focused = false) {
  const first = route.stations[0];
  const approachPoints = approaches.flatMap(option => Array.from({ length: 41 }, (_, i) =>
    option.traverse.route.sample(option.s1 * i / 40)));
  const xs = focused ? approachPoints.map(p => p.x) : route.x;
  const zs = focused ? approachPoints.map(p => p.z) : route.z;
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerZ = (Math.min(...zs) + Math.max(...zs)) / 2;
  const scale = Math.min((width - 65) / (Math.max(...xs) - Math.min(...xs)),
    (height - 50) / (Math.max(...zs) - Math.min(...zs)));
  const point = (x, z) => [width / 2 + (x - centerX) * scale, height / 2 + (z - centerZ) * scale];
  const layers = [false, true].map(showSlope => {
    const layer = document.createElement('canvas');
    layer.width = width / 2;
    layer.height = height / 2;
    const ctx = layer.getContext('2d');
    const pixels = ctx.createImageData(layer.width, layer.height);
    for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) {
      const wx = centerX + (x * 2 - width / 2) / scale;
      const wz = centerZ + (y * 2 - height / 2) / scale;
      const terrain = route.terrain;
      const dx = (terrain.heightAt(wx + 4, wz) - terrain.heightAt(wx - 4, wz)) / 8;
      const dz = (terrain.heightAt(wx, wz + 4) - terrain.heightAt(wx, wz - 4)) / 8;
      const slope = Math.atan(Math.hypot(dx, dz)) * 180 / Math.PI;
      const shade = 24 + 80 * Math.max(0, Math.min(1, .63 + dx * .9 + dz * .8));
      const rgb = showSlope && slope >= 15 ? [shade + 80, shade * .7, shade * .6]
        : showSlope && slope >= 9 ? [shade + 55, shade + 25, shade * .6]
          : showSlope ? [shade * .57, shade + 22, shade * .9] : [shade + 36, shade + 10, shade * .84];
      pixels.data.set([...rgb, 255], (y * layer.width + x) * 4);
    }
    ctx.putImageData(pixels, 0, 0);
    return layer;
  });

  const s1 = point(first.x, first.z);
  const paths = approaches.map(option => {
    const path = new Path2D();
    for (let i = 0; i <= 60; i++) {
      const p = option.traverse.route.sample(option.s1 * i / 60);
      if (i) path.lineTo(...point(p.x, p.z));
      else path.moveTo(...point(p.x, p.z));
    }
    return { option, path };
  });
  function draw(ctx, mode, selected) {
    ctx.drawImage(layers[mode === 'slope' ? 1 : 0], 0, 0, width, height);
    if (!focused) {
      ctx.beginPath();
      for (let i = Math.ceil(first.s / route.step); i < route.count; i += 2) {
        const p = point(route.x[i], route.z[i]);
        if (i > Math.ceil(first.s / route.step)) ctx.lineTo(...p);
        else ctx.moveTo(...p);
      }
      ctx.strokeStyle = '#10212a';
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.strokeStyle = '#6695a0';
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    for (const { option, path } of [...paths.filter(item => item.option !== selected), ...paths.filter(item => item.option === selected)]) {
      ctx.strokeStyle = option.color;
      ctx.lineWidth = option === selected ? 5 : 3;
      ctx.setLineDash(option === selected ? [] : option.id === 'shortest' ? [4, 5] : option.id === 'longer' ? [11, 5] : []);
      ctx.stroke(path);
    }
    ctx.setLineDash([]);
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    const start = route.sample(0);
    const [hx, hy] = point(start.x, start.z);
    ctx.fillStyle = '#d1f6ff';
    ctx.fillRect(hx - 4, hy - 4, 8, 8);
    ctx.fillText('HAB', hx + 17, hy + 15);
    for (const stop of route.stops) {
      if ((focused && stop.ref !== first) || stop.ref.final) continue;
      const p = route.sample(stop.s);
      const [x, y] = point(p.x, p.z);
      const gate = stop.kind === 'gate';
      ctx.fillStyle = gate ? '#ffc178' : '#d1f6ff';
      ctx.beginPath();
      if (gate) {
        ctx.moveTo(x, y - 7); ctx.lineTo(x + 7, y + 5); ctx.lineTo(x - 7, y + 5); ctx.closePath();
      } else ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      if (!gate && stop.ref !== first) {
        ctx.strokeStyle = '#0e1a20';
        ctx.lineWidth = 3;
        ctx.strokeText(stop.ref.id, x + 14, y - 8);
        ctx.fillText(stop.ref.id, x + 14, y - 8);
      }
    }
    const metres = focused ? 50 : 200;
    const bar = metres * scale;
    ctx.fillStyle = '#e5f7ff';
    ctx.fillRect(14, height - 20, bar, 2);
    ctx.textAlign = 'left';
    ctx.fillText(`${metres} m`, 14, height - 25);
  };
  return { draw, s1, pick(ctx, x, y) {
    ctx.save();
    ctx.lineWidth = 14;
    const choice = paths.find(({ path }) => ctx.isPointInStroke(path, x, y))?.option;
    ctx.restore();
    return choice;
  } };
}
