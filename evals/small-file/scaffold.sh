#!/usr/bin/env bash
set -euo pipefail
{
  for i in $(seq 1 39); do
    echo "export const value${i} = ${i};"
  done
} > small.ts
