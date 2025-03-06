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
  set filepath $1
  set filename $(basename "$filepath")
  set filename (string replace -r '\.[^.]*$' '' $filename)
  ffmpeg -i $filepath -c:v libx264 -vf scale=-2:720 -crf 28 -preset veryslow -an "$filename.mp4"
end
function git_current_branch --description "Outputs current git branch"
  git branch --show-current
end

# Git helpers
function git_main_branch --description "Outputs main git branch"
  git remote show origin | grep "HEAD branch" | cut -d' ' -f5
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
    git switch $(git branch --sort=-committerdate | grep -v "\*" | fzf)
  else
    git switch $branch
  end
end

function set_git_abbreviations
  abbr -a -g g          git
  abbr -a -g ga         git add
  abbr -a -g gaa        git add --all
  abbr -a -g gbd        git branch -d
  abbr -a -g gbD        git branch -D
  abbr -a -g gc         git commit -v
  abbr -a -g gcv        git commit -v --no-verify
  abbr -a -g gcm        git commit -m
  abbr -a -g gclean     git clean -di
  abbr -a -g gclean!    git clean -dfx
  abbr -a -g gd         git diff
  abbr -a -g gfo        git fetch origin
  abbr -a -g gll        git pull origin
  abbr -a -g glo        git log --oneline --decorate --color
  abbr -a -g gloo       "git log --pretty=format:'%C(yellow)%h %Cred%ad %Cblue%an%Cgreen%d %Creset%s' --date=short"
  abbr -a -g grba       git rebase --abort
  abbr -a -g grbc       git rebase --continue
  abbr -a -g grbi       git rebase --interactive
  abbr -a -g grbs       git rebase --skip
  abbr -a -g ggu        git pull --rebase origin \(git_current_branch\)
  abbr -a -g grhh       git reset --hard
  abbr -a -g gss        git status -s
  abbr -a -g gst        git status
  abbr -a -g gsta       git stash
  abbr -a -g gstd       git stash drop
  abbr -a -g gstl       git stash list
  abbr -a -g gstp       git stash pop
  abbr -a -g gsw        git switch
  abbr -a -g gswc       git switch --create

  abbr -a -g gcom       git checkout \(git_main_branch\)
  abbr -a -g gpom       git pull origin \(git_main_branch\)
  abbr -a -g gpush      git push origin \(git_current_branch\)
  abbr -a -g gpushf     git push --force-with-lease origin \(git_current_branch\)
  abbr -a -g gfix       "git commit -m 'Fix' && git rebase -i HEAD~2"

  # gh cli abbreviations
  abbr -a -g ghprd      gh pr create -d
  abbr -a -g ghpr       gh pr view --web
end

function set_abbreviations
  abbr -a -g rm        safe-rm
  abbr -a -g cls       clear
  abbr -a -g p         pnpm
  abbr -a -g vim       nvim

  set_git_abbreviations
end

# Environment variables
function set_env_vars
  set -g fish_greeting

  set -x EDITOR          nvim
  set -x PKG_CONFIG_PATH "/opt/homebrew/opt/libffi/lib/pkgconfig:/opt/homebrew/opt/expat/lib/pkgconfig:/opt/homebrew/opt/zlib/lib/pkgconfig"

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
  set_abbreviations

  set_fzf
  set_jump
  set_fnm

  set_prompt
end

