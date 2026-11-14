/// <reference lib="webworker" />
// Natural-colour compositing off the main thread (see colorize.ts).
// In:  the detail tile as Cesium decoded it (an ImageBitmap, pre-flipped for
//      WebGL), the colour tile URL and the patch of it under the detail tile.
// Out: an ImageBitmap in the same flipped orientation, ready for upload.
// Doing this on a main-thread canvas froze flights for ~1 s: drawing on a
// GPU canvas and uploading it as a texture forces a read-back per tile.

export interface ColorJob {
  id: number;
  detail: ImageBitmap;
  colorUrl: string;
  patch: { sx: number; sy: number; size: number };
  strength: number;
}

const colorTiles = new Map<string, Promise<ImageBitmap | null>>();
const MAX_COLOR_TILES = 96;

function colorTile(url: string): Promise<ImageBitmap | null> {
  const hit = colorTiles.get(url);
  if (hit) {
    colorTiles.delete(url);
    colorTiles.set(url, hit);
    return hit;
  }
  const p = fetch(url)
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => (b ? createImageBitmap(b) : null))
    .catch(() => null);
  colorTiles.set(url, p);
  while (colorTiles.size > MAX_COLOR_TILES) {
    const oldest = colorTiles.keys().next().value as string;
    void colorTiles.get(oldest)?.then((b) => b?.close());
    colorTiles.delete(oldest);
  }
  return p;
}

self.onmessage = async (e: MessageEvent<ColorJob>) => {
  const { id, detail, colorUrl, patch, strength } = e.data;
  const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    const w = detail.width;
    const h = detail.height;
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d')!;
    g.drawImage(detail, 0, 0); // flipped, as received
    const color = await colorTile(colorUrl);
    if (color) {
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.globalCompositeOperation = 'color';
      g.globalAlpha = strength;
      // the colour tile is upright: draw it flipped to match the detail
      g.save();
      g.translate(0, h);
      g.scale(1, -1);
      g.drawImage(color, patch.sx, patch.sy, patch.size, patch.size, 0, 0, w, h);
      g.restore();
      g.globalCompositeOperation = 'destination-in'; // keep the detail's no-data alpha
      g.globalAlpha = 1;
      g.drawImage(detail, 0, 0);
    }
    detail.close();
    const bitmap = canvas.transferToImageBitmap();
    post({ id, bitmap }, [bitmap]);
  } catch (err) {
    post({ id, error: String(err) });
  }
};
