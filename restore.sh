#!/bin/bash

os="$(uname)"

mv -f ~/.gitignore_global.bak ~/.gitignore_global
cp -r ~/.config/fish.bak/**  ~/.config/fish
rm -rf ~/.config/fish.bak
if [[ $os == "Darwin" ]]; then
  cp -r ~/.config/flashspace.bak/**  ~/.config/flashspace
  rm -rf ~/.config/flashspace.bak
fi

cp -r ~/.config/nvim.bak/**  ~/.config/nvim
rm -rf ~/.config/nvim.bak
cp -r ~/.config/ghostty.bak/**  ~/.config/ghostty
rm -rf ~/.config/ghostty.bak
mv -f ~/.tmux.conf.bak  ~/.tmux.conf 
cp -r ~/.config/lazygit.bak/**  ~/.config/lazygit
rm -rf ~/.config/lazygit.bak
