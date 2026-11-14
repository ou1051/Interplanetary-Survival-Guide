"""Build the bundled Gale site from the public USGS HiRISE COGs (rasterio, Pillow)."""
import json
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

BASE = ('https://astrogeo-ard.s3.us-west-2.amazonaws.com/mars/mro/hirise/'
        'controlled/dtm/PSP_009149_1750_PSP_009294_1750/')
OUTPUT = Path(__file__).resolve().parents[1] / 'src/data/gale'
# Mars 2015 equirectangular metres. Local origin is at the centre.
EAST, NORTH, HALF, STEP = 8143900, -279450, 320, 4
BOUNDS = (EAST - HALF, NORTH - HALF, EAST + HALF, NORTH + HALF)

def read(name, size):
    with rasterio.open(BASE + name) as source:
        return source.read(1, window=from_bounds(*BOUNDS, source.transform),
                           out_shape=(size, size), masked=True, resampling=Resampling.bilinear)

height = read('DTEEC_009149_1750_009294_1750_U01.tif', 2 * HALF // STEP)
ortho = read('PSP_009149_1750_RED_A_01_ORTHO.tif', 640)
if np.any(height.mask) or ortho.count() == 0:
    raise ValueError(f'Missing coverage: DEM {np.mean(height.mask):.2%}, ortho {np.mean(ortho.mask):.2%}')
low, high = np.percentile(ortho.compressed(), [2, 98])
Image.fromarray(np.uint8(np.clip((ortho.filled(low) - low) / (high - low), 0, 1) * 255)).save(
    OUTPUT / 'orbital.jpg', quality=88, optimize=True)
offset = float(height[height.shape[0] // 2, height.shape[1] // 2])
payload = dict(size=height.shape[0], step=STEP, east=EAST, north=NORTH,
               offset=round(offset, 2), heights=np.round(np.asarray(height - offset, dtype=float), 1).ravel().tolist())
(OUTPUT / 'elevation.json').write_text(json.dumps(payload, separators=(',', ':')) + '\n')
print('Elevation range:', float(height.min()), float(height.max()))
