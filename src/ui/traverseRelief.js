// Orthographic relief sampled from the same terrain the rover drives over.
export class TraverseRelief {
  constructor(route) {
    const margin = 80;
    const x0 = Math.min(...route.x) - margin;
    const x1 = Math.max(...route.x) + margin;
    const z0 = Math.min(...route.z) - margin;
    const z1 = Math.max(...route.z) + margin;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const elevation = route.terrain.heightAt(0, 0);
    this.project = (x, z, y, lift = 0) => [
      (x - cx) + (z - cz) * 0.30,
      (z - cz) * 0.48 - (y - elevation) * 1.8 - lift,
    ];
    const cols = 34, rows = 32;
    this.mesh = Array.from({ length: rows + 1 }, (_, row) =>
      Array.from({ length: cols + 1 }, (_, col) => {
        const x = x0 + (x1 - x0) * col / cols;
        const z = z0 + (z1 - z0) * row / rows;
        const y = route.terrain.heightAt(x, z);
        return { point: this.project(x, z, y), y };
      }));
    const points = this.mesh.flat().map(({ point }) => point);
    this.bounds = {
      left: Math.min(...points.map(([x]) => x)),
      right: Math.max(...points.map(([x]) => x)),
      top: Math.min(...points.map(([, y]) => y)),
      bottom: Math.max(...points.map(([, y]) => y)),
    };
    this.path = [];
    for (let i = 0; i < route.count; i += 4) {
      this.path.push(this.project(route.x[i], route.z[i], route.h[i], 2));
    }
    this.stops = route.stops.map(({ kind, s, ref }) => {
      const { x, z } = route.sample(s);
      return { kind, ref, point: this.project(x, z, route.terrain.heightAt(x, z), 2) };
    });
  }

  draw(canvas, selected) {
    const width = canvas.clientWidth;
    if (!width) return;
    const height = width * 0.66;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const { left, right, top, bottom } = this.bounds;
    const scale = Math.min((width - 25) / (right - left), (height - 54) / (bottom - top));
    const toScreen = ([x, y]) => [
      width / 2 + (x - (left + right) / 2) * scale,
      height / 2 + (y - (top + bottom) / 2) * scale + 3,
    ];
    const trace = (points) => {
      ctx.beginPath();
      points.forEach((point, index) => {
        const [x, y] = toScreen(point);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
    };

    ctx.fillStyle = '#0a190e';
    ctx.fillRect(0, 0, width, height);
    for (let row = 0; row < this.mesh.length - 1; row++) {
      const back = this.mesh[row], front = this.mesh[row + 1];
      for (let col = 0; col < front.length - 1; col++) {
        const a = back[col], b = back[col + 1], c = front[col + 1], d = front[col];
        const light = Math.max(0, Math.min(1, 0.42 + (a.y - b.y + a.y - d.y) / 28));
        trace([a.point, b.point, c.point, d.point]);
        ctx.closePath();
        ctx.fillStyle = `hsl(121 36% ${8 + light * 19}%)`;
        ctx.fill();
        ctx.strokeStyle = '#9be97924';
        ctx.lineWidth = 0.65;
        ctx.stroke();
      }
    }

    trace(this.path);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#09180c';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.strokeStyle = '#a4f67c';
    ctx.lineWidth = 1.8;
    ctx.shadowColor = '#a4f67c';
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;

    const marker = ({ point, kind, ref }, active) => {
      const [x, y] = toScreen(point);
      const r = active ? 6 : 4;
      const symbol = kind === 'gate' ? '▲' : ref.final ? '■' : '◆';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (active) {
        ctx.beginPath();
        ctx.arc(x, y, 11, 0, 2 * Math.PI);
        ctx.fillStyle = '#17291a';
        ctx.fill();
        ctx.strokeStyle = '#e2ffd1';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.font = `bold ${r * 3}px monospace`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#0a190e';
      ctx.strokeText(symbol, x, y);
      ctx.fillStyle = kind === 'gate' ? '#d9ec9e' : '#beff99';
      ctx.fillText(symbol, x, y);
      if (kind !== 'gate' && !active) {
        ctx.font = 'bold 10px monospace';
        ctx.strokeText(ref.id, x + 13, y - 10);
        ctx.fillText(ref.id, x + 13, y - 10);
      }
    };
    this.stops.forEach((stop, index) => {
      if (index !== selected) marker(stop, false);
    });
    if (this.stops[selected]) marker(this.stops[selected], true);
  }
}
