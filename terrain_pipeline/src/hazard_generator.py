print("Script is running!")

import os 
import json
import cv2
import numpy as np
import rasterio


SITES = [
    {
        "id": "jezero",
        "name": "Jezero Crater · River Delta",
        "coords": "18.38° N, 77.58° E",
        "lat": 18.38,
        "lon": 77.58,
        "summary": "Ancient lakebed & western braided river delta fan",
        "tif": "data/jezero_crater.tif",
    },
    {
        "id": "gale",
        "name": "Gale Crater · Vera Rubin Ridge",
        "coords": "5.40° S, 137.80° E",
        "lat": -5.40,
        "lon": 137.80,
        "summary": "Layered sulfate & hematite-rich sedimentary ridge",
        "tif": "data/jezero_crater.tif",
    },
    {
        "id": "valles",
        "name": "Valles Marineris · Candor Chasma",
        "coords": "6.50° S, 289.20° E",
        "lat": -6.50,
        "lon": 289.20,
        "summary": "Deep tectonic canyon floor with steep fault scarps",
        "tif": "data/jezero_crater.tif",
    },
    {
        "id": "olympus",
        "name": "Olympus Mons · Caldera Flank",
        "coords": "18.65° N, 226.20° E",
        "lat": 18.65,
        "lon": 226.20,
        "summary": "Basaltic shield volcano aureole & lava channels",
        "tif": "data/jezero_crater.tif",
    },
    {
        "id": "hellas",
        "name": "Hellas Planitia · Dao Vallis",
        "coords": "42.40° S, 70.50° E",
        "lat": -42.40,
        "lon": 70.50,
        "summary": "Deep impact basin floor & outflow valley",
        "tif": "data/jezero_crater.tif",
    },
]


def resolve_path(relative_path):
    """Resolve a path relative to either the current working directory or terrain_pipeline/."""
    if os.path.exists(relative_path):
        return relative_path
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    candidate = os.path.join(base_dir, relative_path)
    return candidate


def load_elevation_data(file_path):
    resolved_path = resolve_path(file_path)
    print(f"Attempting to load: {resolved_path}")

    if not os.path.exists(resolved_path):
        print(f"ERROR: File not found at {os.path.abspath(resolved_path)}")
        return None

    with rasterio.open(resolved_path) as dataset:
        elevation_data = dataset.read(1).astype(np.float32)
        # Resize immediately before doing any math for performance
        elevation_data = cv2.resize(elevation_data, (500, 500), interpolation=cv2.INTER_AREA)
        nodata_val = dataset.nodata

        if nodata_val is not None:
            valid_data = elevation_data[elevation_data != nodata_val]
            min_elev = np.nanmin(valid_data) if valid_data.size > 0 else 0
            elevation_data[elevation_data == nodata_val] = min_elev

        if np.isnan(elevation_data).any():
            min_elev = np.nanmin(elevation_data)
            elevation_data = np.nan_to_num(elevation_data, nan=min_elev)

        print("-" * 30)
        print(f"Array Shape: {elevation_data.shape} (Rows, Columns)")
        print(f"Max Elevation: {np.max(elevation_data):.2f} meters")
        print(f"Min Elevation: {np.min(elevation_data):.2f} meters")
        print("-" * 30)

        return elevation_data


def calculate_slopes(elevation_array):
    gy, gx = np.gradient(elevation_array)
    slope_magnitude = np.sqrt(gx**2 + gy**2)

    print("-" * 30)
    print(f"Max Slope Magnitude: {np.max(slope_magnitude):.2f}")
    print(f"Min Slope Magnitude: {np.min(slope_magnitude):.2f}")
    print("-" * 30)

    return slope_magnitude


def analyze_terrain(elevation_grid, horizontal_scale=30.0):
    """
    1) Calculate slope magnitude in degrees using numpy.gradient.
    2) Find craters/holes by subtracting the original grid from a heavily blurred version (cv2.GaussianBlur).
    Returns (slope_grid, crater_grid).
    """
    gy, gx = np.gradient(elevation_grid, horizontal_scale)
    slope_magnitude = np.sqrt(gx**2 + gy**2)
    slope_grid = np.degrees(np.arctan(slope_magnitude))

    blurred_grid = cv2.GaussianBlur(elevation_grid, (51, 51), 0)
    crater_grid = blurred_grid - elevation_grid

    print("-" * 30)
    print(f"Slope (deg) - Max: {np.max(slope_grid):.2f}°, Min: {np.min(slope_grid):.2f}°")
    print(f"Crater Depth - Max: {np.max(crater_grid):.2f}, Min: {np.min(crater_grid):.2f}")
    print("-" * 30)

    return slope_grid, crater_grid


def generate_cost_matrix(
    slope_grid,
    crater_grid,
    caution_slope=15.0,
    severe_slope=28.0,
    shallow_crater=10.0,
    deep_crater=20.0,
):
    """
    Combine slope and crater/depression grids into a pathfinding cost matrix:
      1   = Safe terrain
      5   = Moderate slope / minor hitch (caution)
      10  = Shallow crater / local depression
      100 = Severe slope / cliff hitch or deep crater (impassable/extreme hazard)
    """
    cost_matrix = np.ones_like(slope_grid, dtype=int)
    cost_matrix[slope_grid > caution_slope] = 5
    cost_matrix[crater_grid > shallow_crater] = 10
    cost_matrix[(slope_grid > severe_slope) | (crater_grid > deep_crater)] = 100
    return cost_matrix


def create_layer_composite_rgb(
    elevation_grid,
    slope_grid,
    crater_grid,
    show_heights=True,
    show_steepness=True,
    show_craters=True,
    caution_slope=15.0,
    severe_slope=28.0,
    shallow_crater=10.0,
    deep_crater=20.0,
):
    """
    Build an RGB image (float 0..1) with toggleable layers:
      - Base relief (always visible underneath)
      - Heights (hypsometric elevation tint)
      - Steepness (moderate & severe slopes/hitches)
      - Craters (shallow & deep local depressions)
    """
    elev_min = float(np.min(elevation_grid))
    elev_max = float(np.max(elevation_grid))
    norm_elev = (elevation_grid - elev_min) / max(elev_max - elev_min, 1e-5)

    # Shaded Martian relief base
    gy, gx = np.gradient(norm_elev)
    shade = np.clip(0.65 - gx * 4.5 - gy * 4.5, 0.2, 1.0)
    base_rgb = np.stack([
        norm_elev * 0.65 * shade + 0.12,
        norm_elev * 0.48 * shade + 0.08,
        norm_elev * 0.38 * shade + 0.06,
    ], axis=-1)

    rgb = base_rgb.copy()

    if show_heights:
        # Hypsometric tint: low = deep teal/green, mid = warm ochre, high = bright ivory/rust
        h_r = np.interp(norm_elev, [0.0, 0.35, 0.7, 1.0], [0.12, 0.25, 0.82, 0.98])
        h_g = np.interp(norm_elev, [0.0, 0.35, 0.7, 1.0], [0.45, 0.72, 0.64, 0.88])
        h_b = np.interp(norm_elev, [0.0, 0.35, 0.7, 1.0], [0.55, 0.36, 0.22, 0.75])
        height_rgb = np.stack([h_r * shade, h_g * shade, h_b * shade], axis=-1)
        rgb = rgb * 0.35 + height_rgb * 0.65

    if show_steepness:
        caution_mask = (slope_grid > caution_slope) & (slope_grid <= severe_slope)
        severe_mask = slope_grid > severe_slope
        rgb[caution_mask] = rgb[caution_mask] * 0.35 + np.array([0.98, 0.78, 0.12]) * 0.65
        rgb[severe_mask] = rgb[severe_mask] * 0.20 + np.array([0.92, 0.16, 0.16]) * 0.80

    if show_craters:
        shallow_mask = (crater_grid > shallow_crater) & (crater_grid <= deep_crater)
        deep_mask = crater_grid > deep_crater
        rgb[shallow_mask] = rgb[shallow_mask] * 0.30 + np.array([0.15, 0.78, 0.95]) * 0.70
        rgb[deep_mask] = rgb[deep_mask] * 0.18 + np.array([0.78, 0.18, 0.88]) * 0.82

    return np.clip(rgb, 0.0, 1.0)


def create_hazard_overlay_rgb(
    elevation_grid,
    slope_grid,
    crater_grid,
    caution_slope=15.0,
    severe_slope=28.0,
    shallow_crater=10.0,
    deep_crater=20.0,
):
    return create_layer_composite_rgb(
        elevation_grid,
        slope_grid,
        crater_grid,
        show_heights=True,
        show_steepness=True,
        show_craters=True,
        caution_slope=caution_slope,
        severe_slope=severe_slope,
        shallow_crater=shallow_crater,
        deep_crater=deep_crater,
    )


def export_hazard_grid(cost_matrix, output_filename):
    resolved_out = resolve_path(output_filename)
    os.makedirs(os.path.dirname(os.path.abspath(resolved_out)), exist_ok=True)
    cost_list = cost_matrix.tolist()

    with open(resolved_out, "w") as f:
        json.dump(cost_list, f)

    print(f"Successfully saved cost matrix to {resolved_out}")


def export_web_topography_assets(elevation_grid, slope_grid, crater_grid, cost_matrix):
    """
    Export PNG layer maps and a compact JSON grid into public/jezero/ so the Web Tablet UI
    ('Site Topology' tab) can display and interactively toggle Heights, Steepness, and Craters.
    """
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    out_dir = os.path.join(repo_root, "public", "jezero")
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
            elevation_grid, slope_grid, crater_grid,
            show_heights=sh, show_steepness=ss, show_craters=sc
        )
        bgr = (rgb[:, :, ::-1] * 255).astype(np.uint8)
        cv2.imwrite(os.path.join(out_dir, fname), bgr)

    # Also save preview in terrain_pipeline/data/
    preview_path = resolve_path("data/hazard_map_preview.png")
    rgb_all = create_layer_composite_rgb(elevation_grid, slope_grid, crater_grid, True, True, True)
    cv2.imwrite(preview_path, (rgb_all[:, :, ::-1] * 255).astype(np.uint8))

    # Downsample to 100x100 for fast interactive cursor hover & dynamic canvas rendering in the web app
    grid_size = 100
    elev_100 = cv2.resize(elevation_grid, (grid_size, grid_size), interpolation=cv2.INTER_AREA)
    slope_100 = cv2.resize(slope_grid, (grid_size, grid_size), interpolation=cv2.INTER_AREA)
    crater_100 = cv2.resize(crater_grid, (grid_size, grid_size), interpolation=cv2.INTER_AREA)
    cost_100 = generate_cost_matrix(slope_100, crater_100)

    payload = {
        "width": grid_size,
        "height": grid_size,
        "sourceSize": [500, 500],
        "minElevation": round(float(np.min(elevation_grid)), 2),
        "maxElevation": round(float(np.max(elevation_grid)), 2),
        "maxSlopeDeg": round(float(np.max(slope_grid)), 2),
        "maxCraterDepth": round(float(np.max(crater_grid)), 2),
        "elevation": np.round(elev_100, 1).tolist(),
        "slope": np.round(slope_100, 1).tolist(),
        "crater": np.round(crater_100, 1).tolist(),
        "cost": cost_100.tolist(),
    }
    json_path = os.path.join(out_dir, "topography_grid.json")
    with open(json_path, "w") as f:
        json.dump(payload, f)
    print(f"Exported web topography assets to {out_dir}")


def render_mars_globe_image(selected_idx=0, size=500):
    """Render a shaded 3D Mars globe image centered on the selected site with all 5 site pins."""
    img = np.zeros((size, size, 3), dtype=np.float32)
    # Starry space background
    img[:, :] = [0.04, 0.06, 0.09]

    cx, cy = size // 2, size // 2
    radius = int(size * 0.38)

    y_idx, x_idx = np.ogrid[:size, :size]
    dx = (x_idx - cx) / float(radius)
    dy = (y_idx - cy) / float(radius)
    r2 = dx * dx + dy * dy
    mask = r2 <= 1.0

    z = np.zeros_like(r2)
    z[mask] = np.sqrt(1.0 - r2[mask])

    sel = SITES[selected_idx]
    lat0 = np.radians(sel["lat"])
    lon0 = np.radians(sel["lon"])

    # Inverse orthographic projection to get (lat, lon) on the sphere
    sin_c = np.sqrt(np.clip(r2[mask], 0.0, 1.0))
    cos_c = z[mask]
    lat = np.arcsin(np.clip(cos_c * np.sin(lat0) - dy[mask] * np.cos(lat0), -1.0, 1.0))
    lon = lon0 + np.arctan2(
        dx[mask],
        cos_c * np.cos(lat0) + dy[mask] * np.sin(lat0),
    )

    # Procedural Martian albedo features + polar caps + lighting
    albedo = (
        0.55
        + 0.18 * np.sin(lon * 3.0 + 0.5) * np.cos(lat * 2.0)
        + 0.12 * np.cos(lon * 7.0 - lat * 4.0)
        + 0.08 * np.sin(lon * 13.0 + lat * 9.0)
    )
    light = np.clip(0.35 + 0.65 * (dx[mask] * (-0.35) + dy[mask] * (-0.3) + z[mask] * 0.88), 0.12, 1.05)

    r_ch = np.clip((0.78 * albedo + 0.15) * light, 0.0, 1.0)
    g_ch = np.clip((0.40 * albedo + 0.06) * light, 0.0, 1.0)
    b_ch = np.clip((0.24 * albedo + 0.04) * light, 0.0, 1.0)

    # Polar ice caps
    polar = np.abs(np.degrees(lat)) > 72.0
    r_ch[polar] = np.clip(0.88 * light[polar], 0.0, 1.0)
    g_ch[polar] = np.clip(0.86 * light[polar], 0.0, 1.0)
    b_ch[polar] = np.clip(0.84 * light[polar], 0.0, 1.0)

    # Atmosphere limb glow
    limb = np.power(1.0 - z[mask], 2.5) * 0.45
    r_ch = np.clip(r_ch + limb * 0.9, 0.0, 1.0)
    g_ch = np.clip(g_ch + limb * 0.5, 0.0, 1.0)
    b_ch = np.clip(b_ch + limb * 0.3, 0.0, 1.0)

    img[mask, 0] = r_ch
    img[mask, 1] = g_ch
    img[mask, 2] = b_ch

    return img, (cx, cy, radius, lat0, lon0)


def launch_gui(default_tif="data/jezero_crater.tif"):
    import tkinter as tk
    from tkinter import ttk, filedialog, messagebox
    import matplotlib
    matplotlib.use("TkAgg")
    import matplotlib.pyplot as plt
    from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg, NavigationToolbar2Tk
    from matplotlib.patches import Patch

    root = tk.Tk()
    root.title("Mars Expedition — Globe Site Selector & Topography Analyzer")
    root.geometry("1320x880")
    root.configure(bg="#101419")

    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except tk.TclError:
        pass
    style.configure("TFrame", background="#101419")
    style.configure("TLabel", background="#101419", foreground="#e6edf3", font=("Segoe UI", 10))
    style.configure("Header.TLabel", background="#101419", foreground="#ff7b54", font=("Segoe UI", 13, "bold"))
    style.configure("Status.TLabel", background="#181f29", foreground="#79c0ff", font=("Consolas", 10))
    style.configure("TButton", font=("Segoe UI", 10, "bold"), padding=6)
    style.configure("TCheckbutton", background="#101419", foreground="#e6edf3", font=("Segoe UI", 10, "bold"))

    selected_file = tk.StringVar(value=resolve_path(default_tif))
    screen_stage = tk.StringVar(value="globe")  # 'globe' or 'site'
    selected_site_idx = tk.IntVar(value=0)

    # Toggleable topography features
    show_heights_var = tk.BooleanVar(value=True)
    show_steepness_var = tk.BooleanVar(value=True)
    show_craters_var = tk.BooleanVar(value=True)

    caution_slope_var = tk.DoubleVar(value=15.0)
    severe_slope_var = tk.DoubleVar(value=28.0)
    shallow_crater_var = tk.DoubleVar(value=10.0)
    deep_crater_var = tk.DoubleVar(value=20.0)

    status_text = tk.StringVar(value="Use Left/Right Arrow keys to switch Mars site. Press Enter or Click a site to zoom in.")
    hover_text = tk.StringVar(value="Mars Orbital Globe — 5 Candidate Expedition Sites")

    state = {
        "elevation": None,
        "slope": None,
        "crater": None,
        "cost": None,
        "rgb": None,
        "site_pins": [],
    }

    # --- Top Navigation Bar ---
    top_frame = ttk.Frame(root, padding=(12, 8))
    top_frame.pack(side=tk.TOP, fill=tk.X)

    ttk.Label(top_frame, text="MARS SITE TOPOLOGY & HAZARD ANALYZER", style="Header.TLabel").pack(side=tk.LEFT, padx=(0, 14))

    back_btn = ttk.Button(top_frame, text="← Back to Mars Globe", command=lambda: switch_to_globe())
    back_btn.pack(side=tk.LEFT, padx=4)

    prev_btn = ttk.Button(top_frame, text="◀ Prev Site [←]", command=lambda: cycle_site(-1))
    prev_btn.pack(side=tk.LEFT, padx=4)

    next_btn = ttk.Button(top_frame, text="Next Site [→] ▶", command=lambda: cycle_site(1))
    next_btn.pack(side=tk.LEFT, padx=4)

    zoom_btn = ttk.Button(top_frame, text="Zoom Into Selected Site [Enter]", command=lambda: zoom_into_site())
    zoom_btn.pack(side=tk.LEFT, padx=8)

    def browse_file():
        chosen = filedialog.askopenfilename(
            title="Select Mars DEM (.tif)",
            filetypes=[("TIFF files", "*.tif *.tiff"), ("All files", "*.*")],
        )
        if chosen:
            selected_file.set(chosen)
            process_and_render()

    ttk.Button(top_frame, text="Browse .tif...", command=browse_file).pack(side=tk.RIGHT, padx=4)

    # --- Toggleable Layer Bar (shown in zoomed-in Site view) ---
    layer_frame = ttk.Frame(root, padding=(12, 4))
    layer_frame.pack(side=tk.TOP, fill=tk.X)

    ttk.Label(layer_frame, text="Toggle Topography Layers:").pack(side=tk.LEFT, padx=(0, 10))
    ttk.Checkbutton(
        layer_frame, text="Heights (Elevation)", variable=show_heights_var, command=lambda: refresh_composite()
    ).pack(side=tk.LEFT, padx=8)
    ttk.Checkbutton(
        layer_frame, text="Steepness (Slopes/Hitches)", variable=show_steepness_var, command=lambda: refresh_composite()
    ).pack(side=tk.LEFT, padx=8)
    ttk.Checkbutton(
        layer_frame, text="Craters (Depressions)", variable=show_craters_var, command=lambda: refresh_composite()
    ).pack(side=tk.LEFT, padx=8)

    # --- Figure Canvas ---
    fig = plt.Figure(figsize=(12, 7.2), dpi=100, facecolor="#101419")
    canvas_frame = ttk.Frame(root)
    canvas_frame.pack(side=tk.TOP, fill=tk.BOTH, expand=True, padx=10, pady=4)

    canvas = FigureCanvasTkAgg(fig, master=canvas_frame)
    canvas.get_tk_widget().pack(side=tk.TOP, fill=tk.BOTH, expand=True)

    toolbar = NavigationToolbar2Tk(canvas, canvas_frame)
    toolbar.update()

    bottom_frame = ttk.Frame(root, padding=(12, 6))
    bottom_frame.pack(side=tk.BOTTOM, fill=tk.X)
    ttk.Label(bottom_frame, textvariable=hover_text, style="Status.TLabel").pack(side=tk.LEFT, fill=tk.X, expand=True)
    ttk.Label(bottom_frame, textvariable=status_text).pack(side=tk.RIGHT, padx=(12, 0))

    legend_patches = [
        Patch(facecolor=(0.18, 0.72, 0.36), label="Safe / Low Slope (Cost 1)"),
        Patch(facecolor=(0.98, 0.78, 0.12), label="Moderate Steepness / Hitch (Cost 5)"),
        Patch(facecolor=(0.15, 0.78, 0.95), label="Shallow Crater / Depression (Cost 10)"),
        Patch(facecolor=(0.92, 0.16, 0.16), label="Severe Steepness / Cliff (Cost 100)"),
        Patch(facecolor=(0.78, 0.18, 0.88), label="Deep Crater / Pit (Cost 100)"),
    ]

    def cycle_site(delta):
        idx = (selected_site_idx.get() + delta) % len(SITES)
        selected_site_idx.set(idx)
        site = SITES[idx]
        status_text.set(f"Selected [{idx + 1}/5]: {site['name']} ({site['coords']}) — Press Enter to zoom in")
        render_figure()

    def zoom_into_site():
        screen_stage.set("site")
        site = SITES[selected_site_idx.get()]
        status_text.set(f"Inspecting {site['name']} — Toggle Heights, Steepness, and Craters above")
        render_figure()

    def switch_to_globe():
        screen_stage.set("globe")
        status_text.set("Use Left/Right Arrow keys to switch Mars site. Press Enter or Click a site to zoom in.")
        render_figure()

    def refresh_composite():
        if state["elevation"] is None:
            return
        cs = caution_slope_var.get()
        ss = severe_slope_var.get()
        sc = shallow_crater_var.get()
        dc = deep_crater_var.get()
        state["rgb"] = create_layer_composite_rgb(
            state["elevation"],
            state["slope"],
            state["crater"],
            show_heights=show_heights_var.get(),
            show_steepness=show_steepness_var.get(),
            show_craters=show_craters_var.get(),
            caution_slope=cs,
            severe_slope=ss,
            shallow_crater=sc,
            deep_crater=dc,
        )
        render_figure()

    def render_figure():
        if state["elevation"] is None:
            return
        fig.clear()
        idx = selected_site_idx.get()
        site = SITES[idx]

        if screen_stage.get() == "globe":
            ax = fig.add_subplot(111)
            ax.set_facecolor("#090d12")
            globe_img, (cx, cy, radius, lat0, lon0) = render_mars_globe_image(idx, size=520)
            ax.imshow(globe_img)
            ax.set_axis_off()

            # Plot all 5 sites on the globe
            state["site_pins"] = []
            for i, s in enumerate(SITES):
                lat = np.radians(s["lat"])
                lon = np.radians(s["lon"])
                cos_c = np.sin(lat0) * np.sin(lat) + np.cos(lat0) * np.cos(lat) * np.cos(lon - lon0)
                if cos_c > -0.15:
                    px = cx + radius * np.cos(lat) * np.sin(lon - lon0)
                    py = cy - radius * (np.cos(lat0) * np.sin(lat) - np.sin(lat0) * np.cos(lat) * np.cos(lon - lon0))
                    state["site_pins"].append((i, px, py))
                    is_sel = i == idx
                    color = "#79f2d0" if is_sel else "#ff9e64"
                    size_pt = 160 if is_sel else 70
                    ax.scatter([px], [py], s=size_pt, c=color, edgecolors="#ffffff", linewidths=2, zorder=8)
                    ax.text(
                        px + 10,
                        py - 8,
                        f"{i + 1}. {s['name'].split('·')[0].strip()}",
                        color="#ffffff" if is_sel else "#d0d7de",
                        fontsize=10 if is_sel else 8.5,
                        fontweight="bold" if is_sel else "normal",
                        bbox=dict(boxstyle="round,pad=0.25", fc="#141b24cc" if is_sel else "#0d111799", ec=color if is_sel else "none"),
                        zorder=9,
                    )

            ax.set_title(
                f"MARS ORBITAL GLOBE — Select Landing Site [{idx + 1}/5]: {site['name']}\n"
                f"Use [← / →] Arrow Keys to Switch Site  ·  Press [Enter] or Click Site to Zoom In",
                color="#e6edf3",
                fontsize=12,
                pad=10,
            )

            # Top-left preview inset showing selected site's name and preview picture
            inset = fig.add_axes([0.03, 0.62, 0.24, 0.30])
            inset.imshow(state["rgb"])
            inset.set_xticks([])
            inset.set_yticks([])
            for spine in inset.spines.values():
                spine.set_edgecolor("#79f2d0")
                spine.set_linewidth(2)
            inset.set_title(
                f"SITE {idx + 1} PREVIEW\n{site['name']}\n{site['coords']}",
                color="#79f2d0",
                fontsize=9,
                fontweight="bold",
                backgroundcolor="#101720",
            )
            hover_text.set(f"Selected Site [{idx + 1}/5]: {site['name']} ({site['coords']}) — {site['summary']}")
        else:
            ax = fig.add_subplot(111)
            ax.set_facecolor("#0d1117")
            ax.imshow(state["rgb"], interpolation="nearest")
            cost = state["cost"]
            safe_pct = float(np.mean(cost == 1) * 100.0)
            caution_pct = float(np.mean(cost == 5) * 100.0)
            crater_pct = float(np.mean(cost == 10) * 100.0)
            severe_pct = float(np.mean(cost == 100) * 100.0)

            active_layers = []
            if show_heights_var.get():
                active_layers.append("Heights")
            if show_steepness_var.get():
                active_layers.append("Steepness")
            if show_craters_var.get():
                active_layers.append("Craters")
            layers_str = ", ".join(active_layers) if active_layers else "Base Relief Only"

            ax.set_title(
                f"{site['name']} ({site['coords']}) — Active Layers: [{layers_str}]\n"
                f"Safe: {safe_pct:.1f}%  |  Moderate Steepness: {caution_pct:.1f}%  |  "
                f"Shallow Crater: {crater_pct:.1f}%  |  Severe Hazard: {severe_pct:.1f}%",
                color="#e6edf3",
                fontsize=11.5,
                pad=10,
            )
            ax.tick_params(colors="#8b949e")
            ax.set_xlabel("Column (East →)", color="#8b949e")
            ax.set_ylabel("Row (South →)", color="#8b949e")
            leg = ax.legend(
                handles=legend_patches,
                loc="upper right",
                facecolor="#161b22",
                edgecolor="#30363d",
                labelcolor="#e6edf3",
                fontsize=9,
            )
            leg.set_zorder(10)
            fig.tight_layout()

        canvas.draw_idle()

    def process_and_render():
        tif_path = selected_file.get()
        elev = load_elevation_data(tif_path)
        if elev is None:
            messagebox.showerror("File Error", f"Could not load TIF file:\n{tif_path}")
            return

        slope, crater = analyze_terrain(elev)
        cost = generate_cost_matrix(slope, crater)
        rgb = create_layer_composite_rgb(
            elev, slope, crater,
            show_heights=show_heights_var.get(),
            show_steepness=show_steepness_var.get(),
            show_craters=show_craters_var.get(),
        )

        state["elevation"] = elev
        state["slope"] = slope
        state["crater"] = crater
        state["cost"] = cost
        state["rgb"] = rgb

        export_hazard_grid(cost, "data/cost_matrix.json")
        export_web_topography_assets(elev, slope, crater, cost)
        render_figure()

    def on_canvas_click(event):
        if screen_stage.get() != "globe" or event.xdata is None or event.ydata is None:
            return
        # Check if user clicked near any site pin on the globe, or anywhere on the globe
        for i, px, py in state["site_pins"]:
            if np.hypot(event.xdata - px, event.ydata - py) < 28:
                selected_site_idx.set(i)
                zoom_into_site()
                return
        # Clicking on the selected site or globe zooms into the currently selected site
        zoom_into_site()

    def on_mouse_move(event):
        if screen_stage.get() != "site" or event.inaxes is None or state["elevation"] is None:
            return
        col = int(round(event.xdata))
        row = int(round(event.ydata))
        h, w = state["elevation"].shape
        if 0 <= row < h and 0 <= col < w:
            elev_val = state["elevation"][row, col]
            slope_val = state["slope"][row, col]
            crater_val = state["crater"][row, col]
            cost_val = state["cost"][row, col]
            label_map = {
                1: "SAFE TERRAIN",
                5: "CAUTION: MODERATE STEEPNESS",
                10: "CAUTION: SHALLOW CRATER",
                100: "SEVERE HAZARD (STEEP HITCH / DEEP CRATER)",
            }
            hazard_str = label_map.get(cost_val, "HAZARD")
            hover_text.set(
                f"Cell [{col:3d}, {row:3d}]  |  Height: {elev_val:6.1f} m  |  "
                f"Steepness: {slope_val:5.1f}°  |  Crater Depth: {crater_val:+5.1f} m  |  "
                f"Cost: {cost_val:3d} ({hazard_str})"
            )

    canvas.mpl_connect("button_press_event", on_canvas_click)
    canvas.mpl_connect("motion_notify_event", on_mouse_move)

    root.bind("<Left>", lambda _e: cycle_site(-1))
    root.bind("<Right>", lambda _e: cycle_site(1))
    root.bind("<Return>", lambda _e: zoom_into_site() if screen_stage.get() == "globe" else None)
    root.bind("<Escape>", lambda _e: switch_to_globe() if screen_stage.get() == "site" else None)

    root.after(100, process_and_render)
    root.mainloop()


if __name__ == "__main__":
    print("Main block triggered!")
    data_path = "data/jezero_crater.tif"
    launch_gui(data_path)