#!/usr/bin/env bash
# fetch-osm.sh — re-download the OpenStreetMap geometry the map and geocoder are built from.
#
#   bash tools/fetch-osm.sh
#
# Writes _source/osm/geom.json (footprints, paths, areas — with full geometry) and
# _source/osm/osm.json (centres + tags, handy for spot-checking names and amenities).
#
# Only needed if you want fresher OSM data; the committed files are enough to rebuild.
# Data © OpenStreetMap contributors, licensed ODbL.
set -euo pipefail

OUT="$(cd "$(dirname "$0")/.." && pwd)/_source/osm"
mkdir -p "$OUT"

# Bounding box for the fairgrounds: south,west,north,east.
BBOX="41.5900,-93.5720,41.6070,-93.5400"
# A slightly tighter box for geometry — keeps the neighbourhood out of the drawing.
GEOM_BBOX="41.5900,-93.5600,41.5995,-93.5450"
API="https://overpass-api.de/api/interpreter"

echo "==> footprints, paths and areas (with geometry)"
curl -sS --max-time 180 -X POST "$API" -o "$OUT/geom.json" --data-binary @- <<EOF
[out:json][timeout:90];
(
  way["building"]($GEOM_BBOX);
  way["highway"~"^(residential|service|footway|pedestrian|path|unclassified|tertiary)\$"]($GEOM_BBOX);
  way["leisure"]($GEOM_BBOX);
  way["landuse"]($GEOM_BBOX);
);
out geom tags;
EOF

echo "==> named features and amenities (centres only)"
curl -sS --max-time 180 -X POST "$API" -o "$OUT/osm.json" --data-binary @- <<EOF
[out:json][timeout:60];
(
  node["name"]($BBOX);
  way["building"]["name"]($BBOX);
  way["name"]["highway"]($BBOX);
  node["amenity"]($BBOX);
);
out center tags;
EOF

for f in geom.json osm.json; do
  bytes=$(wc -c < "$OUT/$f")
  echo "    $f  ${bytes} bytes"
  # Fail loudly rather than leaving a truncated file that would quietly shrink the map.
  if [ "$bytes" -lt 20000 ]; then
    echo "    WARNING: $f looks too small — Overpass may have rate-limited. Re-run in a minute." >&2
  fi
done

echo
echo "Now rebuild:  node tools/build-data.js"
