alias vim='nvim'
alias rm="safe-rm"
alias cls='clear'
bindkey -s '^l' 'cls^M'

git_current_branch() {
  git branch --no-color 2> /dev/null | sed -e '/^[^*]/d' -e 's/* \(.*\)/\1/'
}

gpush() {
  git push origin $(git_current_branch)
}

gpushf() {
  git push --force origin $(git_current_branch)
}

gpull() {
  git pull origin $(git_current_branch)
}

alias gpom="git pull origin main"
alias gcm="git checkout main"

export WINHOST="/mnt/c/Users/alican"
alias cdh="cd $WINHOST"

# Linux specific
export PATH="/home/linuxbrew/.linuxbrew/bin:$PATH"
eval $(brew shellenv)
export PATH="$HOME/.local/share/fnm:$HOME/.yarn/bin:$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

# fnm
eval "`fnm env`"

prompt_context(){} 
eval "$(starship init zsh)"

# fzf
[ -f "$HOME/.fzf.zsh" ] && source "$HOME/.fzf.zsh"

# load user specific configuration
[ -f "$HOME/.shell.user.sh" ] && source "$HOME/.shell.user.sh"
