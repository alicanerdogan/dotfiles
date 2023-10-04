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

function zvm_after_init() {
  [ -f ~/.fzf.zsh ] && source ~/.fzf.zsh
  eval "$(starship init zsh)"
}


# Mac specific
export PATH="/opt/homebrew/bin:$PATH"
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
eval $(brew shellenv)
export PKG_CONFIG_PATH="/opt/homebrew/opt/libffi/lib/pkgconfig:/opt/homebrew/opt/expat/lib/pkgconfig:/opt/homebrew/opt/zlib/lib/pkgconfig"
export AWS_SDK_LOAD_CONFIG=true

source $(brew --prefix)/share/zsh-you-should-use/you-should-use.plugin.zsh
source $(brew --prefix)/share/zsh-vi-mode/zsh-vi-mode.plugin.zsh

# fnm
eval "$(fnm env --use-on-cd)"

# load user specific configuration
[ -f "$HOME/.shell.user.sh" ] && source "$HOME/.shell.user.sh"
