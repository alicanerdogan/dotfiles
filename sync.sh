#!/bin/bash

os="$(uname)"

if [[ $os == "Darwin" ]]; then
  cp .shell.mac.sh ~/.shell.sh
  cp .alacritty.mac.toml ~/.alacritty.toml
  cp .wezterm.lua ~/.wezterm.lua 
elif [[ $os == "Linux" ]]; then
  cp .shell.linux.sh ~/.shell.sh
  cp .alacritty.linux.yml ~/.alacritty.yml
fi

cp .config/fish/config.fish ~/.config/fish/config.fish
cp .zshrc ~/.zshrc
cp -r .config/nvim/** ~/.config/nvim
cp -r .config/ghostty/** ~/.config/ghostty
cp -r .config/aerospace/** ~/.config/aerospace
cp -R .tmux.conf ~/.tmux.conf

