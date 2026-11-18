#!/bin/sh
# Install xbmg for the current user, with no sudo.
#
#   curl -fsSL https://raw.githubusercontent.com/jhnhnsn/xbmg/main/install.sh | sh
#
# Environment:
#   XBMG_VERSION      tag to install (for example v0.1.0); default: latest release
#   XBMG_INSTALL_DIR  where the files go; default: ~/.local/share/xbmg
#   XBMG_BIN_DIR      where the xbmg symlink goes; default: ~/.local/bin
#   XBMG_SOURCE_DIR   test hook: copy this local folder instead of downloading

set -eu

REPO="jhnhnsn/xbmg"

say() {
  printf '%s\n' "$*"
}

die() {
  printf 'xbmg install: %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

# fetch URL FILE: download URL to FILE with curl, or wget when curl is missing.
fetch() {
  if have curl; then
    curl -fsSL "$1" -o "$2"
  elif have wget; then
    wget -q "$1" -O "$2"
  else
    die "curl or wget is needed to download xbmg."
  fi
}

check_node() {
  if ! have node; then
    die "Node.js 20 or newer is needed, and node is not on your PATH.
Install it (for example: brew install node), or see https://nodejs.org"
  fi
  node_version=$(node --version 2>/dev/null || true)
  node_major=$(printf '%s' "$node_version" | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')
  if [ -z "$node_major" ] || [ "$node_major" -lt 20 ]; then
    die "Node.js 20 or newer is needed; you have ${node_version:-an unknown version}.
Upgrade it (for example: brew upgrade node), or see https://nodejs.org"
  fi
}

latest_version() {
  api_file="$tmp_dir/latest.json"
  fetch "https://api.github.com/repos/$REPO/releases/latest" "$api_file" ||
    die "could not get the latest release from GitHub. Set XBMG_VERSION (for example XBMG_VERSION=v0.1.0)."
  tag=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$api_file" | head -n 1)
  [ -n "$tag" ] || die "could not read the latest release tag from GitHub."
  printf '%s\n' "$tag"
}

main() {
  check_node

  install_dir=${XBMG_INSTALL_DIR:-"$HOME/.local/share/xbmg"}
  bin_dir=${XBMG_BIN_DIR:-"$HOME/.local/bin"}

  tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t xbmg)
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM

  if [ -n "${XBMG_SOURCE_DIR:-}" ]; then
    [ -f "$XBMG_SOURCE_DIR/bin/xbmg.js" ] || die "XBMG_SOURCE_DIR has no bin/xbmg.js: $XBMG_SOURCE_DIR"
    version=${XBMG_VERSION:-local}
    say "Installing xbmg $version from $XBMG_SOURCE_DIR"
    mkdir -p "$tmp_dir/src"
    cp -R "$XBMG_SOURCE_DIR/bin" "$XBMG_SOURCE_DIR/src" "$tmp_dir/src/"
    for f in package.json LICENSE README.md; do
      if [ -f "$XBMG_SOURCE_DIR/$f" ]; then
        cp "$XBMG_SOURCE_DIR/$f" "$tmp_dir/src/"
      fi
    done
    unpacked="$tmp_dir/src"
  else
    version=${XBMG_VERSION:-}
    if [ -z "$version" ]; then
      version=$(latest_version)
    fi
    case $version in
      v*) ;;
      *) version="v$version" ;;
    esac
    say "Installing xbmg $version"
    fetch "https://github.com/$REPO/archive/refs/tags/$version.tar.gz" "$tmp_dir/xbmg.tar.gz" ||
      die "could not download xbmg $version. Check that the tag exists."
    mkdir -p "$tmp_dir/x"
    tar -xzf "$tmp_dir/xbmg.tar.gz" -C "$tmp_dir/x" || die "could not extract the download."
    unpacked=$(find "$tmp_dir/x" -mindepth 1 -maxdepth 1 -type d | head -n 1)
    [ -n "$unpacked" ] && [ -f "$unpacked/bin/xbmg.js" ] || die "the download has no bin/xbmg.js."
  fi

  mkdir -p "$install_dir" "$bin_dir"
  target="$install_dir/$version"
  rm -rf "$target"
  mv "$unpacked" "$target"
  chmod +x "$target/bin/xbmg.js"
  ln -sf "$target/bin/xbmg.js" "$bin_dir/xbmg"

  # Upgrade in place: remove the other version folders.
  for old in "$install_dir"/*; do
    if [ -d "$old" ] && [ "$old" != "$target" ]; then
      say "Removing old version $(basename "$old")"
      rm -rf "$old"
    fi
  done

  say "Installed xbmg $version to $target"
  say "Linked $bin_dir/xbmg"

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
      say ""
      say "$bin_dir is not on your PATH. Add this line to your shell profile"
      say "(for example ~/.zshrc or ~/.bashrc), then open a new terminal:"
      say ""
      say "  export PATH=\"$bin_dir:\$PATH\""
      ;;
  esac

  if ! have ffmpeg; then
    say ""
    say "Note: inline video needs ffmpeg (for example: brew install ffmpeg)."
  fi

  say ""
  say "Run: xbmg --help"
  say "To uninstall: rm -rf $install_dir $bin_dir/xbmg"
}

main "$@"
