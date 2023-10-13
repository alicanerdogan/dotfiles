#!/bin/bash

os="$(uname)"

if [[ $os == "Darwin" ]]; then
  cp .shell.mac.sh ~/.shell.sh
  cp .alacritty.mac.yml ~/.alacritty.yml
  cp .wezterm.lua ~/.wezterm.lua 
elif [[ $os == "Linux" ]]; then
  cp .shell.linux.sh ~/.shell.sh
  cp .alacritty.linux.yml ~/.alacritty.yml
fi

cp .zshrc ~/.zshrc
cp -r .config/nvim/** ~/.config/nvim
cp -R .tmux.conf ~/.tmux.conf

