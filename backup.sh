#!/bin/bash

os="$(uname)"

cp ~/.gitignore_global ~/.gitignore_global.bak
cp -R ~/.config/fish ~/.config/fish.bak 

if [[ $os == "Darwin" ]]; then
  cp -R ~/.config/flashspace ~/.config/flashspace.bak 
fi

cp -R ~/.config/nvim ~/.config/nvim.bak 
cp -R ~/.config/ghostty ~/.config/ghostty.bak 
cp ~/.tmux.conf ~/.tmux.conf.bak 
cp -R ~/.config/lazygit ~/.config/lazygit.bak 
