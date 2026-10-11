"""Build bounded offline Admin-1 assets from the researched Natural Earth extracts.
Usage: python3 scripts/prepare-geography-assets.py /path/to/map-research
No network access or political-worldview remapping is performed.
"""
import json
import math
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(__file__).resolve().parents[1] / 'src/assets/geography'
destination.mkdir(parents=True, exist_ok=True)

def number(value, fallback=0):
    return value if isinstance(value, (int, float)) and math.isfinite(value) else fallback

def text(value):
    return str(value or '')[:240]

labels_source = json.loads((source / 'natural-earth-admin1-labels.json').read_text())
lines_source = json.loads((source / 'natural-earth-admin1-lines.json').read_text())
labels = []
for item in labels_source['labels']:
    name = item.get('name_zh') or item.get('name_en') or item.get('name')
    if not name:
        continue
    labels.append({
        'id': text(item['adm1_code']), 'name': text(name),
        'localName': text(item.get('name')), 'sourceAdmin': text(item['admin']),
        'sourceCountryCode': text(item['adm0_a3']),
        'longitude': number(item['longitude']), 'latitude': number(item['latitude']),
        'rank': number(item.get('min_label'), 10), 'scaleRank': number(item.get('scalerank'), 10),
        'fclassCn': text(item.get('fclass_cn')), 'fclassUs': text(item.get('fclass_us')),
    })
lines = []
for item in lines_source['lines']:
    lines.append({
        'sourceCountryCode': text(item.get('adm0_a3')),
        'classification': text(item['featurecla']),
        'rank': number(item.get('min_zoom'), 10),
        'fclassCn': text(item.get('fclass_cn')), 'fclassUs': text(item.get('fclass_us')),
        'parts': [[[round(number(p[0]), 4), round(number(p[1]), 4)] for p in part] for part in item['parts']],
    })
assert len(labels) <= 5000 and len(lines) <= 11000
assert sum(len(p) for line in lines for p in line['parts']) <= 120000
metadata = {k: labels_source[k] for k in ['source', 'sourceUrl', 'license', 'crs', 'worldview']}
metadata.update({'labelVersion': labels_source['version'], 'lineVersion': lines_source['version'],
                 'verified': '2026-10-11', 'simplificationDegrees': lines_source['simplificationDegrees']})
(destination / 'natural-earth-admin1.json').write_text(json.dumps({**metadata, 'labels': labels, 'lines': lines}, ensure_ascii=False, separators=(',', ':')) + '\n')
print(f'Wrote {len(labels)} named labels and {len(lines)} line records.')
