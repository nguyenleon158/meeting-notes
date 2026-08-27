#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
build_root="$project_dir/build/macos"
dist_dir="$project_dir/dist"
app_path="$dist_dir/MeetNote.app"
dmg_path="$dist_dir/MeetNote-1.1.1-arm64.dmg"
release_dmg_path="$project_dir/MeetNote-1.1.1-arm64.dmg"
codesign_identity="${MEETNOTE_CODESIGN_IDENTITY:--}"
node_version="26.0.0"
node_sha256="dcee8564c1a9342f9594dd5e52d533894dfef6b85aa771bbbb870baa3c403235"
node_archive="$build_root/node-v$node_version-darwin-arm64.tar.gz"
node_url="https://nodejs.org/dist/v$node_version/node-v$node_version-darwin-arm64.tar.gz"

if [[ "$build_root" != "$project_dir/build/macos" ]]; then
  echo "Unexpected build path" >&2
  exit 1
fi

/bin/rm -rf "$build_root"
/bin/mkdir -p "$build_root" "$dist_dir"

echo "Downloading Node.js v$node_version…"
/usr/bin/curl --fail --location --silent --show-error "$node_url" -o "$node_archive"
actual_node_sha256="$(/usr/bin/shasum -a 256 "$node_archive" | /usr/bin/awk '{print $1}')"
if [[ "$actual_node_sha256" != "$node_sha256" ]]; then
  echo "Node.js archive checksum mismatch" >&2
  exit 1
fi
/usr/bin/tar -xzf "$node_archive" -C "$build_root"

contents="$build_root/MeetNote.app/Contents"
/bin/mkdir -p "$contents/MacOS" "$contents/Resources/app" "$contents/Resources/runtime"
/usr/bin/ditto "$project_dir/macos/Info.plist" "$contents/Info.plist"

echo "Compiling launcher…"
/usr/bin/swiftc -O -target arm64-apple-macos13.0 -framework Cocoa \
  "$project_dir/macos/MeetNoteLauncher.swift" \
  -o "$contents/MacOS/MeetNote"

/usr/bin/ditto "$build_root/node-v$node_version-darwin-arm64/bin/node" "$contents/Resources/runtime/node"
/bin/chmod 755 "$contents/MacOS/MeetNote" "$contents/Resources/runtime/node"

for item in server.js server index.html css js schemas package.json; do
  /usr/bin/ditto "$project_dir/$item" "$contents/Resources/app/$item"
done

echo "Creating app icon…"
icon_preview_dir="$build_root/icon-preview"
iconset_dir="$build_root/MeetNote.iconset"
/bin/mkdir -p "$icon_preview_dir" "$iconset_dir"
/usr/bin/qlmanage -t -s 1024 -o "$icon_preview_dir" "$project_dir/macos/MeetNote-icon.svg" >/dev/null 2>&1
icon_png="$icon_preview_dir/MeetNote-icon.svg.png"

for spec in \
  "16 icon_16x16.png" \
  "32 icon_16x16@2x.png" \
  "32 icon_32x32.png" \
  "64 icon_32x32@2x.png" \
  "128 icon_128x128.png" \
  "256 icon_128x128@2x.png" \
  "256 icon_256x256.png" \
  "512 icon_256x256@2x.png" \
  "512 icon_512x512.png" \
  "1024 icon_512x512@2x.png"; do
  size="${spec%% *}"
  name="${spec#* }"
  /usr/bin/sips -z "$size" "$size" "$icon_png" --out "$iconset_dir/$name" >/dev/null
done
/usr/bin/iconutil -c icns "$iconset_dir" -o "$contents/Resources/MeetNote.icns"

if [[ "$codesign_identity" == "-" ]]; then
  echo "Signing app (ad-hoc)…"
  /usr/bin/codesign --force --sign - "$contents/Resources/runtime/node"
  /usr/bin/codesign --force --deep --sign - "$build_root/MeetNote.app"
else
  echo "Signing app with Developer ID identity…"
  /usr/bin/codesign --force --options runtime --timestamp --sign "$codesign_identity" "$contents/Resources/runtime/node"
  /usr/bin/codesign --force --deep --options runtime --timestamp --sign "$codesign_identity" "$build_root/MeetNote.app"
fi

/bin/rm -rf "$app_path"
/usr/bin/ditto "$build_root/MeetNote.app" "$app_path"

echo "Creating DMG…"
dmg_stage="$build_root/dmg"
/bin/mkdir -p "$dmg_stage"
/usr/bin/ditto "$app_path" "$dmg_stage/MeetNote.app"
/bin/ln -s /Applications "$dmg_stage/Applications"
/bin/rm -f "$dmg_path"
/usr/bin/hdiutil create -volname "MeetNote" -srcfolder "$dmg_stage" -ov -format UDZO "$dmg_path" >/dev/null
/usr/bin/ditto "$dmg_path" "$release_dmg_path"

echo "Built: $dmg_path"
echo "Release copy: $release_dmg_path"
