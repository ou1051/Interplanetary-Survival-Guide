import os
import json
import cv2
import numpy as np
import rasterio
from rasterio.transform import from_bounds

from hazard_generator import (
    analyze_terrain,
    generate_cost_matrix,
    create_layer_composite_rgb,
)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FETCHED_DIR = os.path.join(REPO_ROOT, "terrain_pipeline", "data", "fetched")
DATA_DIR = os.path.join(REPO_ROOT, "terrain_pipeline", "data")
PUBLIC_DIR = os.path.join(REPO_ROOT, "public")

SITE_TIF_NAMES = {
    "vrr": "vrr_gale.tif",
    "sharp": "mount_sharp.tif",
    "valles": "valles_marineris.tif",
    "olympus": "olympus_mons.tif",
}


def stitch_image_tiles(site_dir, tiles_meta, bbox, out_size=500):
    """Stitch geographic tiles into a North-up (out_size x out_size x 3) float32 image (0..255) over bbox."""
    if not tiles_meta:
        return None

    canvas = np.zeros((out_size, out_size, 3), dtype=np.float32)
    weight = np.zeros((out_size, out_size, 1), dtype=np.float32)

    west, east = bbox["west"], bbox["east"]
    south, north = bbox["south"], bbox["north"]

    # Grid of lon/lat for every output pixel
    lons = np.linspace(west, east, out_size, dtype=np.float32)
    lats = np.linspace(north, south, out_size, dtype=np.float32)  # row 0 = north

    for t in tiles_meta:
        fpath = os.path.join(site_dir, t["file"])
        if not os.path.exists(fpath):
            continue
        img = cv2.imread(fpath, cv2.IMREAD_COLOR)
        if img is None:
            continue
        img_rgb = img[:, :, ::-1].astype(np.float32)
        th, tw = img_rgb.shape[:2]
        r = t["rect"]

        # Find output pixel indices covered by this tile
        col_mask = (lons >= r["west"]) & (lons <= r["east"])
        row_mask = (lats <= r["north"]) & (lats >= r["south"])
        if not np.any(col_mask) or not np.any(row_mask):
            continue

        c_idx = np.where(col_mask)[0]
        r_idx = np.where(row_mask)[0]
        c0, c1 = c_idx[0], c_idx[-1] + 1
        r0, r1 = r_idx[0], r_idx[-1] + 1

        # Map output (lons[c0:c1], lats[r0:r1]) into tile pixel coordinates
        u = ((lons[c0:c1] - r["west"]) / max(1e-9, r["east"] - r["west"])) * (tw - 1)
        v = ((r["north"] - lats[r0:r1]) / max(1e-9, r["north"] - r["south"])) * (th - 1)
        map_x, map_y = np.meshgrid(u.astype(np.float32), v.astype(np.float32))

        patch = cv2.remap(
            img_rgb,
            map_x,
            map_y,
            interpolation=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_REPLICATE,
        )
        # Ignore black nodata pixels if any
        valid = (np.max(patch, axis=-1, keepdims=True) > 3.0).astype(np.float32)
        canvas[r0:r1, c0:c1] += patch * valid
        weight[r0:r1, c0:c1] += valid

    mask = weight > 0
    out = np.zeros_like(canvas)
    np.divide(canvas, np.maximum(weight, 1e-5), out=out, where=mask)
    if not np.any(mask):
        return None
    # Fill any tiny missing border pixels with median value
    if not np.all(mask):
        med = np.median(out[mask[:, :, 0]], axis=0)
        for c in range(3):
            ch = out[:, :, c]
            ch[~mask[:, :, 0]] = med[c]
    return out


def stitch_dem_tiles(site_dir, dem_meta, bbox, out_size=500):
    """Stitch LERC float32 DEM tiles into a North-up (out_size x out_size) elevation array in metres."""
    if not dem_meta:
        return None

    canvas = np.zeros((out_size, out_size), dtype=np.float32)
    weight = np.zeros((out_size, out_size), dtype=np.float32)

    west, east = bbox["west"], bbox["east"]
    south, north = bbox["south"], bbox["north"]
    lons = np.linspace(west, east, out_size, dtype=np.float32)
    lats = np.linspace(north, south, out_size, dtype=np.float32)

    for t in dem_meta:
        fpath = os.path.join(site_dir, t["file"])
        if not os.path.exists(fpath):
            continue
        with open(fpath, "r") as f:
            d = json.load(f)
        tw, th = d["width"], d["height"]
        arr = np.array(d["pixels"], dtype=np.float32).reshape((th, tw))
        r = t["rect"]

        col_mask = (lons >= r["west"]) & (lons <= r["east"])
        row_mask = (lats <= r["north"]) & (lats >= r["south"])
        if not np.any(col_mask) or not np.any(row_mask):
            continue

        c_idx = np.where(col_mask)[0]
        r_idx = np.where(row_mask)[0]
        c0, c1 = c_idx[0], c_idx[-1] + 1
        r0, r1 = r_idx[0], r_idx[-1] + 1

        u = ((lons[c0:c1] - r["west"]) / max(1e-9, r["east"] - r["west"])) * (tw - 1)
        v = ((r["north"] - lats[r0:r1]) / max(1e-9, r["north"] - r["south"])) * (th - 1)
        map_x, map_y = np.meshgrid(u.astype(np.float32), v.astype(np.float32))

        patch = cv2.remap(
            arr,
            map_x,
            map_y,
            interpolation=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_REPLICATE,
        )
        valid = np.isfinite(patch) & (patch > -20000) & (patch < 30000)
        v_f = valid.astype(np.float32)
        canvas[r0:r1, c0:c1] += np.where(valid, patch, 0.0)
        weight[r0:r1, c0:c1] += v_f

    if not np.any(weight > 0):
        return None
    out = canvas / np.maximum(weight, 1e-5)
    return out


def build_site_assets(site_id):
    site_dir = os.path.join(FETCHED_DIR, site_id)
    manifest_path = os.path.join(site_dir, "manifest.json")
    if not os.path.exists(manifest_path):
        raise RuntimeError(f"Missing manifest for {site_id}: {manifest_path}")

    with open(manifest_path, "r") as f:
        manifest = json.load(f)

    bbox = manifest["bbox"]
    out_size = 500

    # 1. Stitch high-res CTX mosaic (OnMars/CTX and/or Mars Trek Gale_CTX)
    ctx_rgb = stitch_image_tiles(site_dir, manifest.get("ctxTiles", []), bbox, out_size)
    gale_rgb = stitch_image_tiles(site_dir, manifest.get("galeCtxTiles", []), bbox, out_size)
    color_rgb = stitch_image_tiles(site_dir, manifest.get("colorTiles", []), bbox, out_size)
    dem_m = stitch_dem_tiles(site_dir, manifest.get("dem", []), bbox, out_size)

    if ctx_rgb is None and gale_rgb is not None:
        ctx_rgb = gale_rgb
    elif ctx_rgb is not None and gale_rgb is not None:
        ctx_rgb = ctx_rgb * 0.55 + gale_rgb * 0.45

    # For VRR, also blend in the high-res Curiosity HiRISE DEM (src/data/gale/elevation.json)
    # and orbital image (src/data/gale/orbital.jpg) so it matches the 3D Gale sandbox 100%
    if site_id == "vrr":
        gale_elev_path = os.path.join(REPO_ROOT, "src", "data", "gale", "elevation.json")
        gale_orb_path = os.path.join(REPO_ROOT, "src", "data", "gale", "orbital.jpg")
        if os.path.exists(gale_elev_path):
            with open(gale_elev_path, "r") as gf:
                gd = json.load(gf)
            gs = gd["size"]
            g_arr = np.array(gd["heights"], dtype=np.float32).reshape((gs, gs))
            g_dem_500 = cv2.resize(g_arr, (out_size, out_size), interpolation=cv2.INTER_CUBIC)
            if dem_m is not None:
                dem_m = g_dem_500 * 0.75 + (dem_m - np.mean(dem_m) + np.mean(g_dem_500)) * 0.25
            else:
                dem_m = g_dem_500
        if os.path.exists(gale_orb_path):
            orb_bgr = cv2.imread(gale_orb_path, cv2.IMREAD_COLOR)
            if orb_bgr is not None:
                orb_rgb = cv2.resize(orb_bgr[:, :, ::-1].astype(np.float32), (out_size, out_size), interpolation=cv2.INTER_AREA)
                if ctx_rgb is not None:
                    ctx_rgb = ctx_rgb * 0.5 + orb_rgb * 0.5
                else:
                    ctx_rgb = orb_rgb

    if ctx_rgb is None:
        raise RuntimeError(f"No CTX orbital tiles available for {site_id}")

    # Convert CTX RGB to greyscale luminance and match jezero_crater.tif's INTER_AREA smoothness & dynamic range
    ctx_lum = 0.299 * ctx_rgb[:, :, 0] + 0.587 * ctx_rgb[:, :, 1] + 0.114 * ctx_rgb[:, :, 2]
    sigma_map = {"vrr": 0.95, "sharp": 0.95, "valles": 0.65, "olympus": 0.85}
    sigma = sigma_map.get(site_id, 0.95)
    ctx_clean = cv2.GaussianBlur(ctx_lum.astype(np.float32), (0, 0), sigmaX=sigma, sigmaY=sigma)
    c_p2, c_p98 = np.percentile(ctx_clean, [1.5, 98.5])
    ctx_norm = np.clip((ctx_clean - c_p2) / max(1e-5, c_p98 - c_p2), 0.0, 1.0)
    if site_id in ("valles", "olympus"):
        # Add mild local contrast so L10 canyon gullies & volcano channels match L11 sharpness
        clip_lim = 1.45 if site_id == "valles" else 1.25
        clahe_local = cv2.createCLAHE(clipLimit=clip_lim, tileGridSize=(8, 8))
        ctx_l = clahe_local.apply((ctx_norm * 255).astype(np.uint8)).astype(np.float32) / 255.0
        ctx_norm = 0.60 * ctx_norm + 0.40 * ctx_l

    # Combine real MOLA/HRSC DEM macro relief with high-res CTX topographic structure
    if dem_m is not None:
        d_min, d_max = float(np.min(dem_m)), float(np.max(dem_m))
        dem_norm = (dem_m - d_min) / max(1.0, d_max - d_min)
        real_relief_m = dem_m.copy()
    else:
        dem_norm = cv2.GaussianBlur(ctx_norm, (61, 61), 0)
        real_relief_m = dem_norm * 120.0

    # Blend macro DEM + high-resolution CTX topographic structure
    # and calibrate relief amplitude so Safe ~ 50-60%, Slope5 ~ 20-32%, Crater10 ~ 8-15%, Severe100 ~ 6-14%
    dem_w = 0.25 if site_id in ("valles", "olympus") else 0.32
    raw_blend = dem_w * dem_norm + (1.0 - dem_w) * ctx_norm
    p1, p99 = np.percentile(raw_blend, [1.0, 99.0])
    norm_blend = np.clip((raw_blend - p1) / max(1e-5, p99 - p1), 0.0, 1.0)
    span_map = {"vrr": 205.0, "sharp": 190.0, "valles": 250.0, "olympus": 195.0}
    combined_elev = (8.0 + span_map.get(site_id, 200.0) * norm_blend).astype(np.float32)

    # Save GeoTIFF in terrain_pipeline/data/<site>.tif
    tif_path = os.path.join(DATA_DIR, SITE_TIF_NAMES[site_id])
    transform = from_bounds(bbox["west"], bbox["south"], bbox["east"], bbox["north"], out_size, out_size)
    with rasterio.open(
        tif_path,
        "w",
        driver="GTiff",
        height=out_size,
        width=out_size,
        count=1,
        dtype=np.float32,
        crs="EPSG:4326",
        transform=transform,
    ) as dst:
        dst.write(combined_elev, 1)

    # Run hazard_generator.py's exact terrain analysis & composite pipeline
    slope_grid, crater_grid = analyze_terrain(combined_elev, horizontal_scale=30.0)
    cost_matrix = generate_cost_matrix(slope_grid, crater_grid)

    out_dir = os.path.join(PUBLIC_DIR, site_id)
    os.makedirs(out_dir, exist_ok=True)

    combos = {
        "base.png": (False, False, False),
        "heights.png": (True, False, False),
        "steepness.png": (False, True, False),
        "craters.png": (False, False, True),
        "heights_steepness.png": (True, True, False),
        "heights_craters.png": (True, False, True),
        "steepness_craters.png": (False, True, True),
        "combined.png": (True, True, True),
    }

    for fname, (sh, ss, sc) in combos.items():
        rgb = create_layer_composite_rgb(
            combined_elev,
            slope_grid,
            crater_grid,
            show_heights=sh,
            show_steepness=ss,
            show_craters=sc,
        )
        bgr = (rgb[:, :, ::-1] * 255).astype(np.uint8)
        cv2.imwrite(os.path.join(out_dir, fname), bgr)

    # Export 100x100 topography_grid.json matching public/jezero/topography_grid.json schema
    grid_size = 100
    elev_100 = cv2.resize(combined_elev, (grid_size, grid_size), interpolation=cv2.INTER_AREA)
    slope_100 = cv2.resize(slope_grid, (grid_size, grid_size), interpolation=cv2.INTER_AREA)
    crater_100 = cv2.resize(crater_grid, (grid_size, grid_size), interpolation=cv2.INTER_AREA)
    cost_100 = generate_cost_matrix(slope_100, crater_100)

    payload = {
        "width": grid_size,
        "height": grid_size,
        "sourceSize": [500, 500],
        "bbox": bbox,
        "realElevationSpanM": [
            round(float(np.min(real_relief_m)), 1),
            round(float(np.max(real_relief_m)), 1),
        ],
        "minElevation": round(float(np.min(combined_elev)), 2),
        "maxElevation": round(float(np.max(combined_elev)), 2),
        "maxSlopeDeg": round(float(np.max(slope_grid)), 2),
        "maxCraterDepth": round(float(np.max(crater_grid)), 2),
        "elevation": np.round(elev_100, 1).tolist(),
        "slope": np.round(slope_100, 1).tolist(),
        "crater": np.round(crater_100, 1).tolist(),
        "cost": cost_100.tolist(),
    }
    with open(os.path.join(out_dir, "topography_grid.json"), "w") as f:
        json.dump(payload, f)

    safe_pct = float(np.mean(cost_100 == 1) * 100.0)
    caution_pct = float(np.mean(cost_100 == 5) * 100.0)
    crater_pct = float(np.mean(cost_100 == 10) * 100.0)
    severe_pct = float(np.mean(cost_100 == 100) * 100.0)
    print(
        f"[{site_id}] Exported {tif_path} & public/{site_id}/* | "
        f"Safe={safe_pct:.1f}% Slope5={caution_pct:.1f}% Crater10={crater_pct:.1f}% Severe100={severe_pct:.1f}%"
    )
    return payload


def grid_to_world(r, c, N=100):
    nx = (c + 0.5) / N
    ny = (r + 0.5) / N
    return round(-700.0 + nx * 1600.0), round(-1200.0 + ny * 1600.0)


def find_safe_spot_near(cost_100, slope_100, target_r, target_c, radius=10):
    best_r, best_c = target_r, target_c
    best_score = 1e9
    for dr in range(-radius, radius + 1):
        for dc in range(-radius, radius + 1):
            rr = int(np.clip(target_r + dr, 8, 91))
            cc = int(np.clip(target_c + dc, 8, 91))
            c_val = cost_100[rr, cc]
            s_val = slope_100[rr, cc]
            dist = np.hypot(dr, dc)
            score = c_val * 50.0 + s_val * 2.0 + dist * 1.5
            if score < best_score:
                best_score = score
                best_r, best_c = rr, cc
    return grid_to_world(best_r, best_c), (best_r, best_c)


if __name__ == "__main__":
    dem_export = {}
    for sid in ["vrr", "sharp", "valles", "olympus"]:
        payload = build_site_assets(sid)
        elev = np.array(payload["elevation"], dtype=np.float32)
        slope = np.array(payload["slope"], dtype=np.float32)
        crater = np.array(payload["crater"], dtype=np.float32)
        cost = np.array(payload["cost"], dtype=int)

        e64 = cv2.resize(elev, (64, 64), interpolation=cv2.INTER_AREA)
        e_mean = float(np.mean(e64))
        e_std = max(1.0, float(np.std(e64)))
        e_norm = np.round((e64 - e_mean) / e_std, 3).tolist()
        dem_export[sid] = {"size": 64, "grid": e_norm, "bbox": payload["bbox"]}

        for qname, (r0, r1, c0, c1) in [
            ("Zone1", (25, 58, 22, 55)),
            ("Zone2", (55, 86, 25, 78)),
            ("Zone3", (22, 72, 56, 88)),
        ]:
            sub_s = slope[r0:r1, c0:c1]
            sub_c = crater[r0:r1, c0:c1]
            score = sub_s * 1.2 + sub_c * 1.8
            idx = np.unravel_index(np.argmax(score), score.shape)
            rr, cc = r0 + idx[0], c0 + idx[1]
            wx, wz = grid_to_world(rr, cc)
            print(
                f"  [{sid} {qname} Hazard]: grid=({rr},{cc}) world=[{wx}, {wz}] "
                f"slope={slope[rr,cc]:.1f} crater={crater[rr,cc]:.1f} cost={cost[rr,cc]}"
            )

    dem_json_path = os.path.join(REPO_ROOT, "src", "data", "marsSitesDem.json")
    with open(dem_json_path, "w") as f:
        json.dump(dem_export, f)
    print(f"Exported 3D sandbox DEM grids to {dem_json_path}")

