#!/bin/bash

os="$(uname)"

if [[ $os == "Darwin" ]]; then
  cp ~/.shell.sh .shell.mac.sh 
  cp ~/.alacritty.yml .alacritty.mac.yml 
elif [[ $os == "Linux" ]]; then
  cp ~/.shell.sh .shell.linux.sh 
  cp ~/.alacritty.yml .alacritty.linux.yml 
fi

cp ~/.zshrc .zshrc 
cp -r ~/.config/nvim/** .config/nvim
cp ~/.tmux.conf .tmux.conf 

