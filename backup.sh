#!/bin/bash

os="$(uname)"

cp ~/.gitignore_global ~/.gitignore_global.bak
cp ~/.shell.sh ~/.shell.sh.bak
cp -R ~/.config/fish ~/.config/fish.bak 

if [[ $os == "Darwin" ]]; then
  cp ~/.wezterm.lua ~/.wezterm.lua.bak 
  cp ~/.alacritty.toml ~/.alacritty.toml.bak 
  cp -R ~/.config/flashspace ~/.config/flashspace.bak 
elif [[ $os == "Linux" ]]; then
  cp ~/.alacritty.yml ~/.alacritty.yml.bak 
fi

cp ~/.zshrc ~/.zshrc.bak 
cp -R ~/.config/nvim ~/.config/nvim.bak 
cp -R ~/.config/ghostty ~/.config/ghostty.bak 
cp ~/.tmux.conf ~/.tmux.conf.bak 
cp -R ~/.config/lazygit ~/.config/lazygit.bak 

