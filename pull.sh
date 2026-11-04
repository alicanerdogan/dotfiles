#!/bin/bash

os="$(uname)"

cp ~/.gitignore_global .gitignore_global

if [[ $os == "Darwin" ]]; then
  cp -r ~/.config/flashspace/** .config/flashspace
fi

cp -r ~/.config/fish/** .config/fish
cp -r ~/.config/nvim/** .config/nvim
cp -r ~/.config/ghostty/** .config/ghostty
cp ~/.tmux.conf .tmux.conf
cp -r ~/.config/lazygit/** .config/lazygit
