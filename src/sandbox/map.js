export function createMap(canvas, site, route) {
  const context = canvas.getContext('2d');
  canvas.setAttribute('aria-label', 'North-up rehearsal map: fictional base, numbered science stations, chosen route and your position.');
  let low = Infinity, high = -Infinity;
  for (const h of site.elevationM) {
    if (h !== null) { low = Math.min(low, h); high = Math.max(high, h); }
  }
  return function draw(walk, heading) {
    const width = canvas.width;
    const height = canvas.height;
    const scale = Math.min((width - 40) / (site.width * site.cellSizeM), (height - 52) / (site.height * site.cellSizeM));
    const left = (width - site.width * site.cellSizeM * scale) / 2;
    const top = 24 + (height - 52 - site.height * site.cellSizeM * scale) / 2;
    const point = (x, z) => [left + (x + site.cellSizeM / 2) * scale, top + (z + site.cellSizeM / 2) * scale];
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#131d21';
    context.fillRect(0, 0, width, height);
    context.font = '12px sans-serif';
    context.textAlign = 'left';
    context.fillStyle = '#dce8e6';
    context.fillText('N ↑   ' + (site.name || site.id), left, 15);
    for (let row = 0; row < site.height; row++) {
      for (let col = 0; col < site.width; col++) {
        const elevation = site.elevationM[row * site.width + col];
        context.fillStyle = elevation === null ? '#080c0e' : `hsl(26 25% ${27 + 22 * (elevation - low) / (high - low || 1)}%)`;
        context.fillRect(left + col * site.cellSizeM * scale, top + row * site.cellSizeM * scale, site.cellSizeM * scale - 1, site.cellSizeM * scale - 1);
      }
    }
    context.beginPath();
    route.cells.forEach((cell, index) => {
      const [x, y] = point(cell.col * site.cellSizeM, cell.row * site.cellSizeM);
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.strokeStyle = '#96dfc3';
    context.lineWidth = 2;
    context.stroke();
    for (const [index, place] of [{ cell: site.base }, ...site.stations].entries()) {
      const [x, y] = point(place.cell.col * site.cellSizeM, place.cell.row * site.cellSizeM);
      context.fillStyle = index === 0 ? '#c7f0ff' : place.color || (index === 1 ? '#ffb75e' : '#b5b1ff');
      context.beginPath();
      context.arc(x, y, 8, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#131d21';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = 'bold 11px sans-serif';
      context.fillText(index === 0 ? 'B' : String(index), x, y);
    }
    const [x, y] = point(walk.x, walk.z);
    context.save();
    context.translate(x, y);
    context.rotate(heading);
    context.beginPath();
    context.moveTo(0, -10); context.lineTo(6, 7); context.lineTo(0, 3); context.lineTo(-6, 7); context.closePath();
    context.fillStyle = '#ffffff'; context.strokeStyle = '#131d21'; context.lineWidth = 2;
    context.fill(); context.stroke();
    context.restore();
    context.textBaseline = 'alphabetic';
    context.textAlign = 'left';
    context.font = '11px sans-serif';
    context.fillStyle = '#dce8e6';
    context.fillText(`Each cell ${site.cellSizeM} m · B fictional base`, left, height - 8);
  };
}
