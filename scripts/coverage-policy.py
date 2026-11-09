#!/usr/bin/env python3
"""Print a policy floor; optional local overrides may only raise it."""
import json
import os
from pathlib import Path
import sys

policy = json.loads((Path(__file__).resolve().parent.parent / 'coverage-policy.json').read_text())
floor = policy[sys.argv[1]][sys.argv[2]]
if len(sys.argv) > 3 and os.environ.get(sys.argv[3]):
    override = float(os.environ[sys.argv[3]])
    if not floor <= override <= 100:
        raise SystemExit(f'{sys.argv[3]} must be between the policy floor {floor} and 100')
    floor = override
print(f'{floor:g}')
