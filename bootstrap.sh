#!/bin/bash

os="$(uname)"

if [[ $os == "Darwin" ]]; then
  # update config files
  ./sync.sh
  # install cli tools for mac
  xcode-select --install
  # install oh my zsh
  sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
  # install brew
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # install brew pkgs
  brew bundle
  # install rust
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  # install latest node
  fnm install --latest

  ## Download apps
  # Alacritty
  # Firefox
  # Spotify
  # Chrome
  # Mullvad
  # Vlc Player
fi
