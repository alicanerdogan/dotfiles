#!/bin/bash
# Link this repo's config into $HOME. See SYMLINK-MIGRATION.md for the design.
#
# Usage: ./install.sh [--dry-run] [--adopt] [--force] [path ...]
#
#   (default)  ensure every managed path is a symlink into this repo
#   --adopt    replace real live paths with symlinks. Snapshots the live path
#              first, carries ignored local files into the repo, and refuses if
#              the live path holds entries the repo neither contains nor
#              ignores, or if tracked files differ.
#   --force    with --adopt, proceed despite differing file contents (the repo
#              wins; the live copy is snapshotted). Never overrides missing
#              entries or incompatible file/directory types.
#   --dry-run  print the actions, change nothing
#   path ...   only operate on these live paths (e.g. .config/fish)
#
# Bash 3.2 compatible (macOS /bin/bash).

set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY=0
ADOPT=0
FORCE=0
FAIL=0
ONLY=()

# live path relative to $HOME | path relative to this repo
MAPPINGS='
.config/fish|.config/fish
.config/nvim|.config/nvim
.config/ghostty|.config/ghostty
.config/lazygit|.config/lazygit
.config/flashspace|.config/flashspace
.pi/agent|pi
.gitconfig|.gitconfig
.gitignore_global|.gitignore_global
.tmux.conf|.tmux.conf
'

usage() {
  cat <<'EOF'
Usage: ./install.sh [--dry-run] [--adopt] [--force] [path ...]

  (default)  ensure every managed path is a symlink into this repo
  --adopt    replace real live paths with symlinks (snapshot first; ignored
             local files are carried into the repo; refuses on live entries the
             repo neither contains nor ignores, or on differing tracked files)
  --force    with --adopt, proceed despite differing file contents
             (the repo wins; the live copy is snapshotted)
  --dry-run  print the actions, change nothing
  path ...   only operate on these live paths (e.g. .config/fish .gitconfig)
EOF
}

say() { printf '%s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; FAIL=1; }

known_target() {
  local want="$1" rel reporel
  while IFS='|' read -r rel reporel; do
    [ "$rel" = "$want" ] && return 0
  done <<<"$MAPPINGS"
  return 1
}

selected() {
  [ ${#ONLY[@]} -eq 0 ] && return 0
  local want
  for want in "${ONLY[@]}"; do
    [ "$want" = "$1" ] && return 0
  done
  return 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --adopt)   ADOPT=1 ;;
    --force)   FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) printf 'unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
    *) ONLY+=("$1") ;;
  esac
  shift
done

if [ ${#ONLY[@]} -gt 0 ]; then
  for want in "${ONLY[@]}"; do
    if ! known_target "$want"; then
      printf 'error: unknown path: %s\n' "$want" >&2
      exit 2
    fi
  done
fi

# A git failure must never be mistaken for "no differences".
if [ "$ADOPT" = 1 ] && ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  printf 'error: cannot verify tracked files: %s is not a git repository\n' "$REPO" >&2
  exit 2
fi

# --- snapshot ---------------------------------------------------------------

SNAP_ROOT="$HOME/.dotfiles-backups"
SNAP_DIR=""

snap_init() {
  [ -n "$SNAP_DIR" ] && return 0
  local base n old_umask
  base="$SNAP_ROOT/$(date +%Y%m%d-%H%M%S)"
  n=0
  SNAP_DIR="$base"
  while [ -e "$SNAP_DIR" ]; do
    n=$((n + 1))
    SNAP_DIR="$base-$n"
  done

  old_umask="$(umask)"
  umask 077
  if ! mkdir -p "$SNAP_DIR/home"; then
    umask "$old_umask"
    err "cannot create snapshot dir: $SNAP_DIR"
    SNAP_DIR=""
    return 1
  fi
  umask "$old_umask"

  if ! chmod 700 "$SNAP_ROOT" "$SNAP_DIR" "$SNAP_DIR/home"; then
    err "cannot restrict snapshot permissions: $SNAP_ROOT"
    SNAP_DIR=""
    return 1
  fi

  if ! {
    printf 'host: %s\n' "$(hostname)"
    printf 'when: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'repo: %s\n' "$REPO"
    printf 'head: %s\n' "$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
    printf 'dirty:\n'
    git -C "$REPO" status --porcelain 2>/dev/null | sed 's/^/  /'
    printf 'paths:\n'
  } >"$SNAP_DIR/MANIFEST"; then
    err "cannot write manifest: $SNAP_DIR/MANIFEST"
    SNAP_DIR=""
    return 1
  fi
  chmod 600 "$SNAP_DIR/MANIFEST" 2>/dev/null || true

  say "snapshot $SNAP_DIR"
}

# Owner-only access regardless of umask or the source files' modes: the
# snapshot can contain credentials, sessions, and machine-local settings.
snap_private() { # $1 = destination inside the snapshot
  local d

  # tighten the intermediate directories created for this entry
  d="$(dirname "$1")"
  while [ "$d" != "/" ] && [ "$d" != "$SNAP_DIR" ]; do
    if ! chmod 700 "$d" 2>/dev/null; then
      return 1
    fi
    [ "$d" = "$SNAP_DIR/home" ] && break
    d="$(dirname "$d")"
  done

  if ! find "$1" -type d -exec chmod 700 {} + 2>/dev/null; then
    return 1
  fi
  if ! find "$1" -type f -exec chmod go-rwx {} + 2>/dev/null; then
    return 1
  fi
  return 0
}

snap_record() { # $1 = rel, $2 = absolute live path
  local rel="$1" abs="$2" dest kind
  dest="$SNAP_DIR/home/$rel"

  if [ -d "$abs" ] && [ ! -L "$abs" ]; then
    kind="dir"
    if ! mkdir -p "$dest" || ! rsync -a "$abs/" "$dest/"; then
      err "snapshot failed: $rel"
      return 1
    fi
  else
    if [ -L "$abs" ]; then kind="symlink"; else kind="file"; fi
    if ! mkdir -p "$(dirname "$dest")" || ! cp -a "$abs" "$dest"; then
      err "snapshot failed: $rel"
      return 1
    fi
  fi

  if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
    err "snapshot missing after copy: $rel"
    return 1
  fi

  if ! snap_private "$dest"; then
    err "cannot restrict snapshot permissions: $rel"
    return 1
  fi

  if ! printf '%s\t%s\t%s\n' "$rel" "$kind" "$abs" >>"$SNAP_DIR/MANIFEST"; then
    err "cannot update manifest: $SNAP_DIR/MANIFEST"
    return 1
  fi
}

# --- adopt checks -----------------------------------------------------------

same_entry() { # $1 = live path, $2 = repo path; 0 = same, 1 = differs
  local a="$1" b="$2"
  if [ -L "$a" ]; then
    # A live symlink only matches if it already points at the repo file.
    [ "$(readlink "$a")" = "$b" ]
    return
  fi
  if [ ! -e "$a" ]; then
    return 0
  fi
  if [ -d "$a" ] || [ -d "$b" ]; then
    # directories are compared through their tracked children
    [ -d "$a" ] && [ -d "$b" ]
    return
  fi
  cmp -s "$a" "$b"
}

# Classify everything under a live directory that the repo does not contain.
#   "I<TAB>path" = ignored by the repo, so adoption carries it into the repo
#   "U<TAB>path" = not ignored; adoption refuses until it is added or ignored
# 0 = ok, 2 = could not classify.
classify_live_only() { # $1 = rel, $2 = repo rel
  local live="$HOME/$1" reporel="$2" tmp f rc
  if [ ! -d "$live" ] || [ -L "$live" ]; then
    return 0
  fi

  tmp="$(mktemp "${TMPDIR:-/tmp}/dotfiles.XXXXXX")" || return 2
  if ! ( cd "$live" && find . \( -type f -o -type l \) -print0 ) >"$tmp"; then
    rm -f "$tmp"
    return 2
  fi

  while IFS= read -r -d '' f; do
    f="${f#./}"
    if [ -e "$REPO/$reporel/$f" ] || [ -L "$REPO/$reporel/$f" ]; then
      continue
    fi
    git -C "$REPO" check-ignore -q -- "$reporel/$f"
    rc=$?
    case "$rc" in
      0) printf 'I\t%s\n' "$f" ;;
      1) printf 'U\t%s\n' "$f" ;;
      *)
        rm -f "$tmp"
        return 2
        ;;
    esac
  done <"$tmp"

  rm -f "$tmp"
  return 0
}

# Copy a live-only ignored entry into the repo and verify the copy.
copy_local_into_repo() { # $1 = rel, $2 = repo rel, $3 = relative path
  local src="$HOME/$1/$3" dst="$REPO/$2/$3"

  if [ -e "$dst" ] || [ -L "$dst" ]; then
    return 1
  fi
  if ! mkdir -p "$(dirname "$dst")"; then
    return 1
  fi
  if ! cp -a "$src" "$dst"; then
    return 1
  fi

  if [ -L "$src" ]; then
    [ "$(readlink "$src")" = "$(readlink "$dst")" ]
    return
  fi
  cmp -s "$src" "$dst"
}

# Tracked files whose live counterpart exists but differs.
# stdout = offending relative paths; 0 = ok, 2 = could not verify.
differing() { # $1 = rel, $2 = repo rel
  local live="$HOME/$1" reporel="$2" target="$REPO/$2" tmp f relp

  if [ -e "$target" ] && [ ! -d "$target" ]; then
    if ! same_entry "$live" "$target"; then
      printf '%s\n' "$reporel"
    fi
    return 0
  fi

  tmp="$(mktemp "${TMPDIR:-/tmp}/dotfiles.XXXXXX")" || return 2
  if ! git -C "$REPO" ls-files -z -- "$reporel" >"$tmp" 2>/dev/null; then
    rm -f "$tmp"
    return 2
  fi

  while IFS= read -r -d '' f; do
    relp="${f#"$reporel"/}"
    if [ "$relp" = "$f" ]; then
      continue
    fi
    if [ -e "$live/$relp" ] || [ -L "$live/$relp" ]; then
      if ! same_entry "$live/$relp" "$REPO/$f"; then
        printf '%s\n' "$relp"
      fi
    fi
  done <"$tmp"

  rm -f "$tmp"
  return 0
}

# --- operations -------------------------------------------------------------

link_one() { # $1 = rel, $2 = repo rel
  local rel="$1" reporel="$2" live target cur differ class_out line p
  local untracked_list ignored_list
  untracked_list=()
  ignored_list=()
  live="$HOME/$rel"
  target="$REPO/$reporel"

  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    err "repo target missing: $reporel"
    return 0
  fi

  if [ -L "$live" ]; then
    cur="$(readlink "$live")"
    if [ "$cur" = "$target" ]; then
      say "ok      $rel"
    else
      err "$rel -> $cur (expected $target)"
    fi
    return 0
  fi

  if [ -e "$live" ]; then
    if [ "$ADOPT" != 1 ]; then
      err "$rel exists and is not a symlink (use --adopt)"
      return 0
    fi

    # Incompatible entry types are never replaced, not even with --force.
    if [ -d "$live" ] && [ ! -d "$target" ]; then
      err "$rel is a directory but the repo target is a file; refusing"
      return 0
    fi
    if [ ! -d "$live" ] && [ -d "$target" ]; then
      err "$rel is a file but the repo target is a directory; refusing"
      return 0
    fi

    if ! class_out="$(classify_live_only "$rel" "$reporel")"; then
      err "cannot classify $rel; aborting before any change"
      return 0
    fi

    while IFS= read -r line; do
      [ -n "$line" ] || continue
      case "$line" in
        U*) untracked_list+=("${line:2}") ;;
        I*) ignored_list+=("${line:2}") ;;
      esac
    done <<<"$class_out"

    if [ ${#untracked_list[@]} -gt 0 ]; then
      err "$rel has entries the repo neither contains nor ignores:"
      for p in "${untracked_list[@]}"; do
        printf '          %s\n' "$p" >&2
      done
      printf '        add them to the repo, or gitignore them so adoption\n' >&2
      printf '        carries them into %s/%s/ automatically.\n' "$REPO" "$reporel" >&2
      return 0
    fi

    if ! differ="$(differing "$rel" "$reporel")"; then
      err "cannot verify tracked files for $rel; aborting before any change"
      return 0
    fi
    if [ -n "$differ" ] && [ "$FORCE" != 1 ]; then
      err "$rel differs from the repo (--force lets the repo win):"
      printf '%s\n' "$differ" | sed 's/^/          /' >&2
      return 0
    fi

    if [ "$DRY" = 1 ]; then
      if [ ${#ignored_list[@]} -gt 0 ]; then
        say "would   carry ${#ignored_list[@]} ignored local file(s) into the repo for $rel"
      fi
      say "would   snapshot, replace and link $rel"
      return 0
    fi

    snap_init || return 0
    snap_record "$rel" "$live" || return 0

    # Only carry the ignored locals over once the backup is safely written,
    # and refuse to touch the live path if any copy cannot be verified.
    if [ ${#ignored_list[@]} -gt 0 ]; then
      for p in "${ignored_list[@]}"; do
        if ! copy_local_into_repo "$rel" "$reporel" "$p"; then
          err "could not copy local file into the repo: $p"
          err "live path left untouched; snapshot at $SNAP_DIR"
          return 0
        fi
      done
      say "locals  $rel (${#ignored_list[@]} carried into the repo)"
    fi

    if ! rm -rf "$live"; then
      err "could not remove $rel (snapshot kept at $SNAP_DIR)"
      return 0
    fi
    say "adopt   $rel"
  fi

  if [ "$DRY" = 1 ]; then
    say "would   link $rel"
  else
    mkdir -p "$(dirname "$live")"
    if ln -s "$target" "$live"; then
      say "link    $rel"
    else
      err "failed to link $rel"
    fi
  fi
}

# --- main -------------------------------------------------------------------

while IFS='|' read -r rel reporel; do
  [ -n "$rel" ] || continue
  selected "$rel" || continue
  link_one "$rel" "$reporel"
done <<<"$MAPPINGS"

say ""
if [ "$FAIL" != 0 ]; then
  say "Some paths need attention (see errors above)."
  exit 1
fi
if [ "$DRY" = 1 ]; then
  say "dry-run complete."
else
  say "done."
fi
