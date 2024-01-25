#!/bin/bash

os="$(uname)"

mv -f ~/.shell.sh.bak  ~/.shell.sh 
if [[ $os == "Darwin" ]]; then
  cp ~/.wezterm.lua.bak ~/.wezterm.lua
  mv -f ~/.alacritty.toml.bak  ~/.alacritty.toml
elif [[ $os == "Linux" ]]; then
  mv -f ~/.alacritty.yml.bak  ~/.alacritty.yml 
fi
 
mv -f ~/.zshrc.bak  ~/.zshrc 
cp -r ~/.config/nvim.bak/**  ~/.config/nvim
rm -rf ~/.config/nvim.bak
mv -f ~/.tmux.conf.bak  ~/.tmux.conf 

