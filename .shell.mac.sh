vim() {
  NVIM_LISTEN_ADDRESS="/tmp/nvimsocket$(date +%s%N)"
  nvim --listen $NVIM_LISTEN_ADDRESS "$@"
}
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
  git push --force-with-lease origin $(git_current_branch)
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

togglealacrittytheme() {
  sed \
    -e '/#START_OF_INACTIVE_THEME/,/#END_OF_INACTIVE_THEME/ s/^# //' \
    -e '/#START_OF_ACTIVE_THEME/,/#END_OF_ACTIVE_THEME/ s/^/# /' \
    -e 's/^# #START_OF_ACTIVE_THEME$/#TEMP_START/' \
    -e 's/^#START_OF_INACTIVE_THEME$/#START_OF_ACTIVE_THEME/' \
    -e 's/^#TEMP_START$/#START_OF_INACTIVE_THEME/' \
    -e 's/^# #END_OF_ACTIVE_THEME$/#TEMP_END/' \
    -e 's/^#END_OF_INACTIVE_THEME$/#END_OF_ACTIVE_THEME/' \
    -e 's/^#TEMP_END$/#END_OF_INACTIVE_THEME/' \
    ~/.alacritty.toml > ~/.alacritty.tmp.toml && \
    mv ~/.alacritty.tmp.toml ~/.alacritty.toml
}

togglenvimtheme() {
  sed \
    -e "s/^local theme = 'dark'$/##__LIGHT__##/" \
    -e "s/^local theme = 'light'$/##__DARK__##/" \
    -e "s/^##__LIGHT__##$/local theme = 'light'/" \
    -e "s/^##__DARK__##$/local theme = 'dark'/" \
    ~/.config/nvim/init.lua > ~/.config/nvim/init.tmp.lua && \
    mv ~/.config/nvim/init.tmp.lua ~/.config/nvim/init.lua

  is_dark=$(grep -c "local theme = 'dark'" ~/.config/nvim/init.lua)
  if [[ "$is_dark" == "1" ]]; then
    for socket in /tmp/nvimsocket*; do
      if [ -S "$socket" ]; then
        nvim --server "$socket" --remote-send '<Esc>:SwitchTheme dark<CR>'
      fi
    done
  else
    for socket in /tmp/nvimsocket*; do
      if [ -S "$socket" ]; then
        nvim --server "$socket" --remote-send '<Esc>:SwitchTheme light<CR>'
      fi
    done
  fi
}

toggletheme() {
  togglealacrittytheme
  togglenvimtheme
}

alias p="pnpm"

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

# jump
eval "$(jump shell)"

# load user specific configuration
[ -f "$HOME/.shell.user.sh" ] && source "$HOME/.shell.user.sh"
