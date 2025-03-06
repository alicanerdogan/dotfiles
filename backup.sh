#!/bin/bash

os="$(uname)"

cp ~/.shell.sh ~/.shell.sh.bak
cp ~/.config/fish/config.fish ~/.config/fish/config.fish.bak 

if [[ $os == "Darwin" ]]; then
  cp ~/.wezterm.lua ~/.wezterm.lua.bak 
  cp ~/.alacritty.toml ~/.alacritty.toml.bak 
elif [[ $os == "Linux" ]]; then
  cp ~/.alacritty.yml ~/.alacritty.yml.bak 
fi

cp ~/.zshrc ~/.zshrc.bak 
cp -R ~/.config/nvim ~/.config/nvim.bak 
cp -R ~/.config/ghostty ~/.config/ghostty.bak 
cp ~/.tmux.conf ~/.tmux.conf.bak 

