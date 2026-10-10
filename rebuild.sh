#!/usr/bin/env bash
set -euo pipefail

wait_for_key_press() {
    if [ -t 0 ]; then
        read -n 1 -s -r -p "Press any key to exit..."
        echo
    fi
}

trap wait_for_key_press EXIT

rm -rf dist
mkdir -p dist

cp index.html style.css dist/
cp -R blog dist/

render_blog_page() {
    sed "s|{{root}}|$1|g" blog/index.html
}

render_blog_page "../" > dist/blog/index.html

npm run build:ts

node dist/scripts/build-posts.js

echo "Website built successfully in ./dist"
