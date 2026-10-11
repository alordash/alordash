#!/usr/bin/env bash
set -euo pipefail

wait_for_key_press() {
    local status=$?
    if [ "$status" -eq 0 ]; then
        return
    fi
    echo "Rebuild failed with exit code $status." >&2
    if [ -t 0 ]; then
        read -n 1 -s -r -p "Press any key to exit..."
        echo
    else
        cmd //c pause
    fi
}

trap wait_for_key_press EXIT

rm -rf dist
mkdir -p dist

cp index.html style.css dist/
cp -R blog dist/

npm run build:ts

node dist/scripts/build-posts.js

echo "Website built successfully in ./dist"
