#!/usr/bin/env python3
"""
Cut a data raster to exactly the DEM's square so it can be draped on the terrain.
Run tools/prepare_dem.py first (it stores the georeferencing in site.json).

  pip install rasterio numpy pillow
  python tools/prepare_layer.py optical  hirise_or_ctx.tif
  python tools/prepare_layer.py thermal  themis_thermal_inertia.tif --source "THEMIS night-IR thermal inertia"
  python tools/prepare_layer.py mineral  --r olivine.tif --g clay.tif --b pyroxene.tif --source "CRISM parameter maps"

Output goes to public/dem/{optical,thermal,mineral}.png (row 0 = north).
mineral.png channels: R = olivine, G = clay/carbonate, B = pyroxene (0-255 = weak..strong).
Inputs may be in any CRS; they are reprojected to the DEM grid.
"""
import argparse, json
import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.warp import reproject, Resampling
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("mode", choices=["optical", "thermal", "mineral"])
ap.add_argument("input", nargs="?")
ap.add_argument("--r"), ap.add_argument("--g"), ap.add_argument("--b")
ap.add_argument("--dem", default="public/dem/site")
ap.add_argument("--out", default="public/dem")
ap.add_argument("--size", type=int, default=1024)
ap.add_argument("--source", default=None, help="label shown in the UI")
a = ap.parse_args()

meta = json.load(open(a.dem + ".json"))
B = meta["bounds"]
dst_tf = from_bounds(B["west"], B["south"], B["east"], B["north"], a.size, a.size)


def warp(path, band=1):
    dst = np.full((a.size, a.size), np.nan, dtype="float32")
    with rasterio.open(path) as src:
        reproject(rasterio.band(src, band), dst, dst_transform=dst_tf, dst_crs=meta["crs"],
                  src_nodata=src.nodata, dst_nodata=np.nan, resampling=Resampling.bilinear)
    return dst


def stretch(x, lo=2, hi=98):
    v = x[np.isfinite(x)]
    if v.size == 0:
        raise SystemExit("Raster does not overlap the DEM square (check CRS / location).")
    p0, p1 = np.percentile(v, [lo, hi])
    y = np.clip((x - p0) / max(p1 - p0, 1e-9), 0, 1)
    return np.nan_to_num(y, nan=0.0), float(p0), float(p1)


def save(arr_u8, name):
    Image.fromarray(arr_u8).save(f"{a.out}/{name}.png")
    print("wrote", f"{a.out}/{name}.png")


if a.mode == "optical":
    with rasterio.open(a.input) as s:
        nb = s.count
    bands = [warp(a.input, i) for i in (1, 2, 3)] if nb >= 3 else [warp(a.input, 1)] * 3
    stack = np.stack(bands, -1)
    mx = np.nanmax(stack)
    if mx <= 255 and mx > 1.5:      # already 8-bit style values
        y = np.nan_to_num(stack / 255.0)
    else:                            # float / 16-bit: percentile stretch
        y, _, _ = stretch(stack)
    save((y * 255).astype("uint8"), "optical")
    meta["layers"]["optical"] = {"source": a.source or "REAL · orthoimage"}

elif a.mode == "thermal":
    g = warp(a.input, 1)
    v = g[np.isfinite(g)]
    lo, hi = (float(x) for x in np.percentile(v, [1, 99]))
    y = np.nan_to_num(np.clip((g - lo) / max(hi - lo, 1e-9), 0, 1), nan=float(np.median((v - lo) / max(hi - lo, 1e-9))))
    save((y * 255).astype("uint8"), "thermal")
    meta["layers"]["thermal"] = {"min": lo, "max": hi, "source": a.source or "REAL · thermal inertia"}

else:
    ch = []
    for p in (a.r, a.g, a.b):
        if p:
            y, _, _ = stretch(warp(p, 1))
        else:
            y = np.zeros((a.size, a.size), dtype="float32")
        ch.append(y)
    save((np.stack(ch, -1) * 255).astype("uint8"), "mineral")
    meta["layers"]["mineral"] = {"source": a.source or "REAL · spectral parameter maps"}

json.dump(meta, open(a.dem + ".json", "w"), indent=2)