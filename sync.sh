#!/bin/bash

os="$(uname)"

cp .gitignore_global ~/.gitignore_global

if [[ $os == "Darwin" ]]; then
  cp .shell.mac.sh ~/.shell.sh
  cp .alacritty.mac.toml ~/.alacritty.toml
  cp .wezterm.lua ~/.wezterm.lua 
  cp -r .config/flashspace/** ~/.config/flashspace
elif [[ $os == "Linux" ]]; then
  cp .shell.linux.sh ~/.shell.sh
  cp .alacritty.linux.yml ~/.alacritty.yml
fi

cp -r .config/fish/** ~/.config/fish
cp .zshrc ~/.zshrc
cp -r .config/nvim/** ~/.config/nvim
cp -r .config/ghostty/** ~/.config/ghostty
cp -R .tmux.conf ~/.tmux.conf
cp -r .config/lazygit/** ~/.config/lazygit

