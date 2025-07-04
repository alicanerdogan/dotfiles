#!/bin/bash

os="$(uname)"

mv -f ~/.shell.sh.bak  ~/.shell.sh 
mv -f ~/.config/fish/config.fish.bak ~/.config/fish/config.fish
if [[ $os == "Darwin" ]]; then
  cp ~/.wezterm.lua.bak ~/.wezterm.lua
  mv -f ~/.alacritty.toml.bak  ~/.alacritty.toml
  cp -r ~/.config/flashspace.bak/**  ~/.config/flashspace
  rm -rf ~/.config/flashspace.bak
elif [[ $os == "Linux" ]]; then
  mv -f ~/.alacritty.yml.bak  ~/.alacritty.yml 
fi
 
mv -f ~/.zshrc.bak  ~/.zshrc 
cp -r ~/.config/nvim.bak/**  ~/.config/nvim
rm -rf ~/.config/nvim.bak
cp -r ~/.config/ghostty.bak/**  ~/.config/ghostty
rm -rf ~/.config/ghostty.bak
mv -f ~/.tmux.conf.bak  ~/.tmux.conf 

