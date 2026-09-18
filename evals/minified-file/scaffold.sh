#!/usr/bin/env bash
set -euo pipefail
python3 -c "
import json
data = {f'key_{i}': 'x' * 80 for i in range(500)}
open('minified.json', 'w').write(json.dumps(data))
"
