#!/bin/bash

mv -f ~/.shell.sh.bak  ~/.shell.sh 
mv -f ~/.alacritty.yml.bak  ~/.alacritty.yml 
 
mv -f ~/.zshrc.bak  ~/.zshrc 
cp -r ~/.config/nvim.bak/**  ~/.config/nvim
rm -rf ~/.config/nvim.bak
mv -f ~/.tmux.conf.bak  ~/.tmux.conf 

