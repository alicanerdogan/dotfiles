# Utilities
function notify --description "Native MacOS Notification"
  set DEFAULT_TITLE      'Command Complete'
  set DEFAULT_SUBTITLE   ''
  set TITLE              $DEFAULT_TITLE
  set SUBTITLE           $DEFAULT_SUBTITLE

  if [ -n "$1" ]
    set TITLE $1
  end

  osascript -e "display notification \"Terminal\" with title \"$TITLE\" subtitle \"$SUBTITLE\" sound name \"Blow\""
end

function optimize --description "Optimizes videos and convert them to HD mp4 videos"
  set filepath $argv[1]
  set filename $(basename "$filepath")
  set filename (string replace -r '\.[^.]*$' '' $filename)
  ffmpeg -i $filepath -c:v libx264 -vf scale=-2:720 -crf 28 -preset veryslow -an "$filename.mp4"
end
function git_current_branch --description "Outputs current git branch"
  git branch --show-current
end

# Git helpers
function git_main_branch --description "Outputs main git branch"
  git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'
end

function ghco --description "Interactive branch picker for PRs"
  gh pr list \
    --author "@me" \
    --json number,title,url,headRefName,state,isDraft,createdAt \
    --template '{{range .}}{{.number}}{{"\t"}}{{.title}}{{"\t"}}{{.headRefName}}{{"\t"}}{{.state}}{{"\t"}}{{.isDraft}}{{"\t"}}{{timeago .createdAt}}{{"\n"}}{{end}}' \
    | fzf --header 'checkout PR' \
    | awk '{print $(NF-5)}' \
    | xargs git checkout
end

function gplog --description "Pretty git log print"
  set HASH          "%C(always,yellow)%h%C(always,reset)"
  set RELATIVE_TIME "%C(always,green)%ar%C(always,reset)"
  set AUTHOR        "%C(always,bold blue)%an%C(always,reset)"
  set REFS          "%C(always,red)%d%C(always,reset)"
  set SUBJECT       "%s"

  set FORMAT        "$HASH $RELATIVE_TIME{$AUTHOR{$REFS $SUBJECT"

  git log --graph --pretty="tformat:$FORMAT" $args |
  column -t -s '{' |
  less -XRS --quit-if-one-screen
end

function gswx --description "Interactive branch picker"
  set branch $1
  if [ -z "$branch" ]
    git switch $(git branch --sort=-committerdate | grep -v "\*" | sed 's/^[[:space:]]*//' | fzf)
  else
    git switch $branch
  end
end

function ggu --description "Pull from the current branch in origin"
  git pull --rebase origin $(git_current_branch)
end

function gpom --description "Pull from the main branch in origin"
  git pull origin $(git_main_branch)
end

function gpush --description "Pushes to the current branch in origin"
  git push origin $(git_current_branch)
end

function gpushf --description "Force pushes to the current branch in origin"
  git push --force-with-lease origin $(git_current_branch)
end

function gswm --description "Switches to main branch"
  git switch $(git_main_branch)
end

function set_git_aliases
  alias g="git"
  alias ga="git add"
  alias gaa="git add --all"
  alias gbd="git branch -d"
  alias gbD="git branch -D"
  alias gc="git commit -v"
  alias gcv="git commit -v --no-verify"
  alias gcm="git commit -m"
  alias gclean="git clean -di"
  alias gclean!="git clean -dfx"
  alias gd="git diff"
  alias gfo="git fetch origin"
  alias gl="git pull"
  alias gll="git pull origin"
  alias glo="git log --oneline --decorate --color"
  alias gloo="git log --pretty=format:'%C(yellow)%h %Cred%ad %Cblue%an%Cgreen%d %Creset%s' --date=short"
  alias grba="git rebase --abort"
  alias grbc="git rebase --continue"
  alias grbi="git rebase --interactive"
  alias grbs="git rebase --skip"
  alias grhh="git reset --hard"
  alias grhs="git reset --soft"
  alias gss="git status -s"
  alias gst="git status"
  alias gsta="git stash"
  alias gstd="git stash drop"
  alias gstl="git stash list"
  alias gstp="git stash pop"
  alias gsw="git switch"
  alias gswc="git switch --create"

  alias gfix="git commit -m 'Fix' && git rebase -i HEAD~2"

  # gh cli 
  alias ghprd="gh pr create -d"
  alias ghpr="gh pr view --web"
end

function set_aliases
  alias rm="safe-rm"
  alias cls="clear"
  alias p="pnpm"
  alias vim="nvim"

  set_git_aliases
end

# Environment variables
function set_env_vars
  set -g fish_greeting

  set -x EDITOR          nvim
  set -x PKG_CONFIG_PATH "/opt/homebrew/opt/libffi/lib/pkgconfig:/opt/homebrew/opt/expat/lib/pkgconfig:/opt/homebrew/opt/zlib/lib/pkgconfig"

  set -x PATH /opt/homebrew/bin $PATH
  set -x PATH /opt/homebrew/opt/openjdk/bin $PATH
end

function set_keybindings
  bind --user -M default alt-backspace backward-kill-word repaint
end

function load_user_config
  if test -f "$HOME/.config/fish/config.user.fish"
    source "$HOME/.config/fish/config.user.fish"
  end
end

function set_prompt
  starship init fish | source
end

function set_brew
  brew shellenv | source
end

function set_fzf
  fzf --fish | source
end

function set_jump
  jump shell fish | source
end

function set_fnm
  fnm env --use-on-cd --shell fish | source
end

set_env_vars
set_brew
load_user_config

if status is-interactive
  fish_vi_key_bindings
  set_keybindings
  set_aliases

  set_fzf
  set_jump
  set_fnm

  set_prompt
end

