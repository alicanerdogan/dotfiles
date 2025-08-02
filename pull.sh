#!/bin/bash

os="$(uname)"

if [[ $os == "Darwin" ]]; then
  cp ~/.shell.sh .shell.mac.sh 
  cp ~/.alacritty.toml .alacritty.mac.toml 
  cp ~/.wezterm.lua .wezterm.lua
  cp -r ~/.config/flashspace/** .config/flashspace
elif [[ $os == "Linux" ]]; then
  cp ~/.shell.sh .shell.linux.sh 
  cp ~/.alacritty.yml .alacritty.linux.yml 
fi

cp ~/.config/fish/config.fish .config/fish/config.fish
cp ~/.zshrc .zshrc 
cp -r ~/.config/nvim/** .config/nvim
cp -r ~/.config/ghostty/** .config/ghostty
cp ~/.tmux.conf .tmux.conf 
cp -r ~/.config/lazygit/** .config/lazygit

