#!/bin/bash

os="$(uname)"

cp ~/.shell.sh ~/.shell.sh.bak
cp ~/.alacritty.yml ~/.alacritty.yml.bak 

if [[ $os == "Darwin" ]]; then
  cp ~/.wezterm.lua ~/.wezterm.lua.bak 
fi

cp ~/.zshrc ~/.zshrc.bak 
cp -R ~/.config/nvim ~/.config/nvim.bak 
cp ~/.tmux.conf ~/.tmux.conf.bak 

