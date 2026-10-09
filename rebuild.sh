#!/usr/bin/env bash
set -euo pipefail

npm ci

rm -rf dist
mkdir -p dist

cp index.html style.css dist/
cp -R blog dist/

npm run build:ts

echo "Website built successfully in ./dist"
