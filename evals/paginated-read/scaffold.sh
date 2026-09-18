#!/usr/bin/env bash
set -euo pipefail
{
  echo "export const N = 0;"
  for i in $(seq 1 499); do
    echo "export function fn${i}(x: number): number { return x + ${i}; }"
  done
} > large.ts
