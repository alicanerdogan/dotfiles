export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="agnoster"
plugins=(git)

zstyle ':omz:update' mode disabled

source $ZSH/oh-my-zsh.sh

# Env specific
source ~/.shell.sh
