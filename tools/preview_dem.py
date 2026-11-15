#!/usr/bin/env python3
"""
Make a picture of your WHOLE elevation file so you can see where the interesting
terrain (delta, scarps, craters) is and pick the crop position.

  python3 tools/preview_dem.py mars_dem.tif
  -> writes dem_preview.png (open it in VS Code) with labelled grid lines.

Each grid label is the X (top edge) or Y (left edge) map coordinate. Pick a spot,
read its X and Y off the grid, then:
  python3 tools/prepare_dem.py mars_dem.tif --cx <X> --cy <Y>
Red/bright areas = steep ground.
"""
import argparse
import numpy as np
import rasterio
from PIL import Image, ImageDraw

ap = argparse.ArgumentParser()
ap.add_argument("input")
ap.add_argument("--width", type=int, default=1100, help="preview width in pixels")
ap.add_argument("--grid", type=float, default=2000.0, help="grid spacing in metres")
ap.add_argument("--out", default="dem_preview.png")
a = ap.parse_args()

with rasterio.open(a.input) as src:
    scale = src.width / a.width
    w = a.width
    h = int(round(src.height / scale))
    z = src.read(1, out_shape=(h, w), resampling=rasterio.enums.Resampling.average).astype("float64")
    nodata = src.nodata
    b = src.bounds
    mpp_x = (b.right - b.left) / w
    mpp_y = (b.top - b.bottom) / h

if nodata is not None:
    z[z == nodata] = np.nan
z[~np.isfinite(z)] = np.nan
fill = np.nanmedian(z)
zf = np.where(np.isnan(z), fill, z)

# hillshade (light from the north-west)
gy, gx = np.gradient(zf, mpp_y, mpp_x)
slope = np.arctan(np.hypot(gx, gy))
aspect = np.arctan2(-gx, gy)
az, alt = np.radians(315), np.radians(40)
shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
shade = np.clip((shade - shade.min()) / (shade.max() - shade.min() + 1e-9), 0, 1)

# elevation tint: low = dark brown, high = light tan
t = (zf - np.nanpercentile(zf, 2)) / (np.nanpercentile(zf, 98) - np.nanpercentile(zf, 2) + 1e-9)
t = np.clip(t, 0, 1)
lo = np.array([90, 55, 40]); hi = np.array([225, 190, 150])
rgb = (lo + (hi - lo) * t[..., None]) * (0.35 + 0.65 * shade[..., None])
img = Image.fromarray(np.clip(rgb, 0, 255).astype("uint8"))
d = ImageDraw.Draw(img)

# labelled grid
x0 = np.ceil(b.left / a.grid) * a.grid
while x0 < b.right:
    px = (x0 - b.left) / mpp_x
    d.line([(px, 0), (px, h)], fill=(255, 255, 255), width=1)
    d.text((px + 3, 3), f"X={int(x0)}", fill=(255, 255, 0))
    x0 += a.grid
y0 = np.ceil(b.bottom / a.grid) * a.grid
while y0 < b.top:
    py = (b.top - y0) / mpp_y
    d.line([(0, py), (w, py)], fill=(255, 255, 255), width=1)
    d.text((3, py + 3), f"Y={int(y0)}", fill=(255, 255, 0))
    y0 += a.grid

# mark the file centre (what you get with no --cx/--cy)
cx, cy = (b.left + b.right) / 2, (b.bottom + b.top) / 2
px, py = (cx - b.left) / mpp_x, (b.top - cy) / mpp_y
d.ellipse([px - 6, py - 6, px + 6, py + 6], outline=(0, 255, 255), width=2)
d.text((px + 9, py - 6), "current crop centre", fill=(0, 255, 255))

img.save(a.out)
print(f"wrote {a.out}  ({w}x{h} px, 1 px = {mpp_x:.0f} m)")
print(f"file centre = X {cx:.0f}, Y {cy:.0f}")