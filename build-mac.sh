#!/bin/sh
# Builds TermClaw for macOS (run on a Mac).
#
#   ./build-mac.sh           dmg + zip + unpacked app (release/)
#   ./build-mac.sh dir       only the unpacked app (release/mac-*/TermClaw.app), fastest
#   ./build-mac.sh test      run the unit tests, then build everything
#
set -e
cd "$(dirname "$0")"

[ "$(uname -s)" = "Darwin" ] || { echo "macOS packages must be built on a Mac."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm not found. Install Node.js 22 or newer."; exit 1; }

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

if [ "$1" = "test" ]; then
  echo "Running unit tests..."
  npm test
fi

# Version from version.txt into package.json (app version, artifact names)
node scripts/version.js

echo "Building renderer and MCP bridge..."
node scripts/build-renderer.js

# identity "-" = ad-hoc signature: no developer certificate needed, the app is not notarized.
if [ "$1" = "dir" ]; then
  echo "Packaging unpacked app..."
  npx electron-builder --mac dir --publish never -c.mac.identity=-
else
  echo "Packaging dmg, zip and unpacked app..."
  npx electron-builder --mac --publish never -c.mac.identity=-
fi

echo
echo "Done. Output in $(pwd)/release"
echo "Not notarized: after copying the app to Applications run once"
echo "  xattr -dr com.apple.quarantine \"/Applications/TermClaw.app\""
