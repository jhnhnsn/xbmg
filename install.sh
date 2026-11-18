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

# check_version V: refuse a version that could point outside the install dir.
check_version() {
  case $1 in
    "" | */* | .* | v.*) die "bad version: '$1'" ;;
  esac
}

main() {
  check_node

  install_dir=${XBMG_INSTALL_DIR:-"$HOME/.local/share/xbmg"}
  bin_dir=${XBMG_BIN_DIR:-"$HOME/.local/bin"}

  tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t xbmg)
  trap 'rm -rf "$tmp_dir"' EXIT
  trap 'exit 1' INT TERM

  if [ -n "${XBMG_SOURCE_DIR:-}" ]; then
    [ -f "$XBMG_SOURCE_DIR/bin/xbmg.js" ] || die "XBMG_SOURCE_DIR has no bin/xbmg.js: $XBMG_SOURCE_DIR"
    version=${XBMG_VERSION:-local}
    check_version "$version"
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
    check_version "$version"
    say "Installing xbmg $version"
    fetch "https://github.com/$REPO/archive/refs/tags/$version.tar.gz" "$tmp_dir/xbmg.tar.gz" ||
      die "could not download xbmg $version. Check that the tag exists."
    mkdir -p "$tmp_dir/x"
    tar -xzf "$tmp_dir/xbmg.tar.gz" -C "$tmp_dir/x" || die "could not extract the download."
    unpacked=
    for d in "$tmp_dir/x"/*; do
      if [ -f "$d/bin/xbmg.js" ]; then
        unpacked=$d
        break
      fi
    done
    [ -n "$unpacked" ] || die "the download has no bin/xbmg.js."
  fi

  mkdir -p "$install_dir" "$bin_dir"
  target="$install_dir/$version"
  staged="$install_dir/.xbmg-new-$$"
  backup="$install_dir/.xbmg-old-$$"
  # Copy into the install dir first (this can cross file systems), then
  # swap with renames, so a failure keeps the old install.
  rm -rf "$staged"
  mv "$unpacked" "$staged" || die "could not write to $install_dir."
  chmod +x "$staged/bin/xbmg.js"
  if [ -e "$target" ]; then
    mv "$target" "$backup" || die "could not replace $target."
  fi
  if ! mv "$staged" "$target"; then
    [ -e "$backup" ] && mv "$backup" "$target"
    die "could not move xbmg into $target."
  fi
  rm -rf "$backup"
  ln -sf "$target/bin/xbmg.js" "$bin_dir/xbmg"

  # Upgrade in place: remove other xbmg version folders. Only remove
  # folders that hold bin/xbmg.js, so other files in a custom
  # XBMG_INSTALL_DIR are safe.
  for old in "$install_dir"/*; do
    if [ -d "$old" ] && [ "$old" != "$target" ] && [ -f "$old/bin/xbmg.js" ]; then
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
  if [ -z "${XBMG_INSTALL_DIR:-}" ]; then
    remove_dir=$install_dir
  else
    # A custom dir can hold other files: name only this version's folder.
    remove_dir=$target
  fi
  say "To uninstall: rm -rf \"$remove_dir\" \"$bin_dir/xbmg\""
}

main "$@"
