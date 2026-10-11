# ExamCraft map asset sources and integration notes

Verified 2026-10-11. ExamCraft bundles the physical assets and an optional, explicitly labelled Natural Earth Admin-1 reference layer. No map image or linework was taken from Google Maps or a textbook.

## Ready-to-use physical assets

- `natural-earth-physical-2160.jpg`: 2160 × 1080 JPEG, 454,686 bytes. Resampled from Natural Earth II 1:50m Shaded Relief and Water v3.2.0. This is a stylized natural-environment/relief reference, not satellite imagery or a classified elevation measurement.
- `natural-earth-land-rings.json`: 128 closed rings, 5,143 coordinates, 106,384 bytes. Converted directly from Natural Earth 1:110m land v4.1.0, rounded to five decimals. Physical land/coastline geometry only; no country-border claims. For SVG, concatenate rings and use the even-odd fill rule.
- Both use WGS84 longitude/latitude. Source TIFF/TFW and GeoTIFF tags confirm terrain bounds (-180, -90, 180, 90), EPSG:4326, north at top. The land SHP's PRJ also specifies WGS84. A linear lon/lat canvas may use x=(lon+180)/360*width; y=(90-lat)/180*height. Terrain should fill the same plot rectangle, with no cropping or different aspect-ratio fitting. If the viewport changes, transform the image and overlays together.
- At global scale these are suitable for teaching geographic relationships; they do not establish PRC review compliance. Retain educational/reference labeling rather than calling them an official standard map.

Publisher pages:

- https://www.naturalearthdata.com/downloads/50m-raster-data/50m-natural-earth-2/
- https://www.naturalearthdata.com/downloads/110m-physical-vectors/110m-land/
- https://www.naturalearthdata.com/about/terms-of-use/

Downloaded originals:

- https://naturalearth.s3.amazonaws.com/50m_raster/NE2_50M_SR_W.zip
- https://naturalearth.s3.amazonaws.com/110m_physical/ne_110m_land.zip

Natural Earth declares its raster and vector datasets public domain and permits modifications and electronic redistribution, including commercial uses. Attribution is optional; retaining `Natural Earth` and source links is good provenance.

## Admin-1 reference assets (not Google or PRC standard)

- `natural-earth-admin1-labels.json`: original v5.1.1 administrative names/codes/label coordinates and display ranks. Preserve `name_zh`, `name_en`, `name`, `adm0_a3`, `adm1_code`, `min_label`, `max_label`, `min_zoom`, and selected worldview/quality fields. Prefer source Chinese names when supplied, with English/local fallback.
- `natural-earth-admin1-lines.json`: original v5.1.0 first-order internal boundary lines, simplified with 0.025 degree Douglas-Peucker tolerance and rounded to four decimals. Do not use for precise boundary measurements. Each item has `parts: [lon, lat][][]`, source country/classification and scale metadata. Draw parts independently, no fill. Break any remaining longitude discontinuity >180 degrees at the antimeridian.
- Source explicitly describes a de facto default and notes that subdivisions are difficult to keep current; some tiny countries and disputed areas have no Admin-1 coverage. It includes US/CN classification fields, but those are Natural Earth's representations, not Google certification or PRC approval. Do not silently turn them into a mixed 'official' worldview.
- Show subdivision labels at country/regional zoom with collision avoidance and a user toggle. Rendering all 4,596 labels at world extent is illegible. Filter by viewport and source display rank; zoom should preserve the underlying lat/lon transform.
- The China-area units in this source are not arranged as a single PRC 34-province dataset. Do not relabel those geometries as PRC official provinces.

Publisher source: https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-1-states-provinces/

Original downloads:

- https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_1_states_provinces.zip
- https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_1_states_provinces_lines.zip

## Files shipped with the application

- Vite bundles `src/assets/geography/natural-earth-physical-2160.jpg` and `natural-earth-land-rings.json` under content-hashed asset names.
- `src/assets/geography/natural-earth-admin1.json` is a separate local dynamic-import chunk, loaded only when the province/state reference layer is selected. It contains 4,589 named labels (seven unnamed source records omitted) and 10,179 boundary records. Source names, grouping, display ranks, US/CN classification metadata and class distinctions are retained without worldview conversion. Coordinates are rounded to four decimals.
- `scripts/prepare-geography-assets.py` reproduces the combined Admin-1 file from extracted Natural Earth label/line JSON inputs. Original extraction scripts/raw archives are reference inputs, not runtime dependencies and are not included in the app.
- This notice is copied to `dist/map-assets/MAP_SOURCES.md` for offline packaged attribution. No Google map content or the older official Beijing preview is bundled.
- The component displays statistical boundaries as fine dashed lines and publisher-marked unrecognized boundaries as dot-dash lines; these are source classifications, not a claim of general recognition. Dataset geometry remains a generalized reference.
- The viewport is bounded to 1–8×; labels are collision-filtered and limited to 70 visible subdivision names. Up to 70,000 boundary vertices / 8,000 path parts are displayed in a view. Dense portions can therefore be omitted. This is not a complete administrative gazetteer or a boundary-verification tool.

Bundled asset SHA-256 values:

- `natural-earth-admin1.json`: `946e588702aa8c9e77c4b32eb6a7ae8459a6878e3d20b3378b0e8c896533d192`
- `natural-earth-land-rings.json`: `600ace4e1ddfa2bcf9c3acf85245eceb7cec7658e1fadabfb2a884e0147dc347`
- `natural-earth-physical-2160.jpg`: `9de01fdb4e4d39e1f401a5657047c0f7de8bcefe70c37c79fc682897735ad2d4`
