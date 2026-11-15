#!/usr/bin/env python3
"""
Turn a real Mars DEM (GeoTIFF) into the heightmap the game loads.
Works on HUGE files: only the window you ask for is read from disk.

  python3 tools/prepare_dem.py big_dem.tif --info                  # print CRS, size, bounds
  python3 tools/prepare_dem.py big_dem.tif --cx 0 --cy 0           # crop 1600 m around map coords (0,0)
  python3 tools/prepare_dem.py big_dem.tif                         # crop around the file's centre
"""
import argparse, json, os
import numpy as np
import rasterio
from rasterio.windows import Window
from scipy.ndimage import zoom, distance_transform_edt

ap = argparse.ArgumentParser()
ap.add_argument("input")
ap.add_argument("--info", action="store_true", help="just print file info and exit")
ap.add_argument("--cx", type=float, default=None, help="crop centre X in the file's CRS (metres)")
ap.add_argument("--cy", type=float, default=None, help="crop centre Y in the file's CRS (metres)")
ap.add_argument("--size", type=int, default=1024, help="output grid N x N")
ap.add_argument("--extent", type=float, default=1600.0, help="square crop side in metres")
ap.add_argument("--out", default="public/dem/site")
a = ap.parse_args()

with rasterio.open(a.input) as src:
    px = abs(src.transform.a)
    if a.info:
        print("size (px):", src.width, "x", src.height, "| pixel:", px, "| CRS projected:", bool(src.crs and src.crs.is_projected))
        print("bounds:", src.bounds)
        print("crs:", src.crs)
        raise SystemExit
    if not src.crs or not src.crs.is_projected:
        raise SystemExit("DEM is not in a projected CRS (metres). Reproject first:\n"
                         '  gdalwarp -t_srs "+proj=eqc +R=3396190 +units=m" in.tif projected.tif')

    cx = a.cx if a.cx is not None else (src.bounds.left + src.bounds.right) / 2
    cy = a.cy if a.cy is not None else (src.bounds.bottom + src.bounds.top) / 2
    n_px = int(round(a.extent / px))
    col, row = ~src.transform * (cx, cy)
    x0 = int(round(col - n_px / 2))
    y0 = int(round(row - n_px / 2))
    x0 = max(0, min(src.width - n_px, x0))
    y0 = max(0, min(src.height - n_px, y0))
    n_px = min(n_px, src.width, src.height)
    arr = src.read(1, window=Window(x0, y0, n_px, n_px)).astype("float64")
    nodata = src.nodata
    west, north = src.transform * (x0, y0)
    crs_wkt = src.crs.to_wkt()
    name = os.path.basename(a.input)

if nodata is not None:
    arr[arr == nodata] = np.nan
arr[~np.isfinite(arr)] = np.nan
if np.isnan(arr).all():
    raise SystemExit("The chosen window has no data. Use --info and pick --cx/--cy inside the bounds.")
if np.isnan(arr).any():
    idx = distance_transform_edt(np.isnan(arr), return_distances=False, return_indices=True)
    arr = arr[tuple(idx)]

grid = zoom(arr, a.size / n_px, order=1)[:a.size, :a.size].astype("float32")
grid -= grid.min()

side = n_px * px
meta = {
    "width": int(grid.shape[1]),
    "height": int(grid.shape[0]),
    "extent": float(side),
    "mPerPx": float(side / grid.shape[0]),
    "minElev": 0.0,
    "maxElev": float(grid.max()),
    "source": name,
    "bounds": {"west": west, "east": west + side, "north": north, "south": north - side},
    "crs": crs_wkt,
    "layers": {},
}
os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
grid.tofile(a.out + ".bin")
json.dump(meta, open(a.out + ".json", "w"), indent=2)
print({k: v for k, v in meta.items() if k != "crs"})
print(f"relief in crop: {grid.max():.1f} m over {side:.0f} m")
if side < 1600:
    print("WARNING: crop is smaller than TERRAIN.inner.size (1600). Edges will be clamped flat.")