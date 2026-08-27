#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
build_root="$project_dir/build/windows"
dist_dir="$project_dir/dist"
launcher_stage="$build_root/launcher"
payload_stage="$build_root/payload"
node_version="26.0.0"
go_version="1.24.5"
node_sha256="d0418640a36096e00bddb57761aa0b1b98f91904ec4ed2b9dd75cbad723becd7"
go_sha256="92d30a678f306c327c544758f2d2fa5515aa60abe9dba4ca35fbf9b8bfc53212"
node_archive="$build_root/node-v$node_version-win-x64.zip"
go_archive="$build_root/go$go_version.darwin-arm64.tar.gz"
node_url="https://nodejs.org/dist/v$node_version/node-v$node_version-win-x64.zip"
go_url="https://go.dev/dl/go$go_version.darwin-arm64.tar.gz"
exe_path="$dist_dir/MeetNote-1.1.1-windows-x64.exe"
release_exe_path="$project_dir/MeetNote-1.1.1-windows-x64.exe"

if [[ "$build_root" != "$project_dir/build/windows" ]]; then
  echo "Unexpected build path" >&2
  exit 1
fi

/bin/rm -rf "$build_root"
/bin/mkdir -p "$build_root" "$dist_dir" "$launcher_stage" "$payload_stage/runtime" "$payload_stage/app"

echo "Downloading Node.js v$node_version for Windows x64…"
/usr/bin/curl --fail --location --silent --show-error "$node_url" -o "$node_archive"
actual_node_sha256="$(/usr/bin/shasum -a 256 "$node_archive" | /usr/bin/awk '{print $1}')"
if [[ "$actual_node_sha256" != "$node_sha256" ]]; then
  echo "Node.js archive checksum mismatch" >&2
  exit 1
fi
/usr/bin/unzip -q "$node_archive" -d "$build_root/node"
/usr/bin/ditto "$build_root/node/node-v$node_version-win-x64/node.exe" "$payload_stage/runtime/node.exe"

for item in server.js server index.html css js schemas package.json; do
  /usr/bin/ditto "$project_dir/$item" "$payload_stage/app/$item"
done

echo "Creating embedded app payload…"
(
  cd "$payload_stage"
  /usr/bin/zip -q -r "$launcher_stage/payload.zip" .
)
/usr/bin/unzip -tq "$launcher_stage/payload.zip" >/dev/null
/usr/bin/ditto "$project_dir/windows/MeetNoteLauncher.go" "$launcher_stage/main.go"
payload_hash="$(/usr/bin/shasum -a 256 "$launcher_stage/payload.zip" | /usr/bin/awk '{print $1}')"

echo "Downloading Go $go_version cross-compiler…"
/usr/bin/curl --fail --location --silent --show-error "$go_url" -o "$go_archive"
actual_go_sha256="$(/usr/bin/shasum -a 256 "$go_archive" | /usr/bin/awk '{print $1}')"
if [[ "$actual_go_sha256" != "$go_sha256" ]]; then
  echo "Go archive checksum mismatch" >&2
  exit 1
fi
/usr/bin/tar -xzf "$go_archive" -C "$build_root"

echo "Compiling MeetNote.exe…"
(
  cd "$launcher_stage"
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
    "$build_root/go/bin/go" build \
    -trimpath \
    -ldflags="-s -w -H windowsgui -X main.buildID=$payload_hash" \
    -o "$exe_path" \
    main.go
)

/usr/bin/ditto "$exe_path" "$release_exe_path"

echo "Built: $exe_path"
echo "Release copy: $release_exe_path"
echo "SHA-256: $(/usr/bin/shasum -a 256 "$exe_path" | /usr/bin/awk '{print $1}')"
