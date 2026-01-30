# Utilities
function notify --description "Native MacOS Notification"
    set DEFAULT_TITLE 'Command Complete'
    set DEFAULT_SUBTITLE ''
    set TITLE $DEFAULT_TITLE
    set SUBTITLE $DEFAULT_SUBTITLE

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
    set HASH "%C(always,yellow)%h%C(always,reset)"
    set RELATIVE_TIME "%C(always,green)%ar%C(always,reset)"
    set AUTHOR "%C(always,bold blue)%an%C(always,reset)"
    set REFS "%C(always,red)%d%C(always,reset)"
    set SUBJECT "%s"

    set FORMAT "$HASH $RELATIVE_TIME{$AUTHOR{$REFS $SUBJECT"

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

function gh-pr-edit-body --description "Edit GitHub PR body interactively"
    set -l pr_number $argv[1]
    set tempfile (mktemp).md
    gh pr view $pr_number --json body -q .body >$tempfile && $EDITOR $tempfile && gh pr edit $pr_number --body-file $tempfile
    rm -f $tempfile
end

function pvim --description "Pick a project to open in vim"
    set -l query $argv[1]
    set PROJECT_DIRS ~/src ~/repos ~/repos/sandbox
    # apply PROJECT_PRIORITY from global env
    set PROJECT_PRIORITY (string split ' ' $PROJECT_PRIORITY)
    set -l priority_entries
    set -l normal_entries

    for base in $PROJECT_DIRS
        if test -d "$base"
            set -l base_name (basename "$base")
            for dir in $base/*/
                if test -d "$dir"
                    set -l proj_name (basename "$dir")
                    set -l entry "$dir"\t"$proj_name [$base_name]"
                    set -l is_priority false

                    for pattern in $PROJECT_PRIORITY
                        if string match -rq "$pattern" "$proj_name"
                            set is_priority true
                            break
                        end
                    end

                    if test "$is_priority" = true
                        set -a priority_entries "$entry"
                    else
                        set -a normal_entries "$entry"
                    end
                end
            end
        end
    end

    set -l entries $priority_entries $normal_entries

    if test (count $entries) -eq 0
        echo "No projects found in: $PROJECT_DIRS"
        return 1
    end

    set -l selected (printf '%s\n' $entries | fzf --height 40% --reverse --tiebreak=index --prompt "Open project: " --with-nth=2 --delimiter='\t' --query="$query")

    or return

    set -l dir (string split \t "$selected")[1]
    cd "$dir"
    $EDITOR .
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

    if test (uname) = Darwin
        set -gx HOMEBREW_DIR /opt/homebrew
    else if test (uname) = Linux
        set -gx HOMEBREW_DIR "/home/linuxbrew/.linuxbrew"
    end

    set -gx EDITOR nvim
    set -x PKG_CONFIG_PATH "$HOMEBREW_DIR/opt/libffi/lib/pkgconfig:$HOMEBREW_DIR/opt/expat/lib/pkgconfig:$HOMEBREW_DIR/opt/zlib/lib/pkgconfig"
    set -gx XDG_CONFIG_HOME "$HOME/.config"

    set -x PATH $HOMEBREW_DIR/bin $PATH
    set -x PATH $HOMEBREW_DIR/opt/openjdk/bin $PATH
    set -x PATH "$HOME/.cargo/bin" $PATH
    set -x PATH "$HOME/.config/fish/bin" $PATH

    # pnpm
    set -gx PNPM_HOME "~/Library/pnpm"
    if not string match -q -- $PNPM_HOME $PATH
        set -gx PATH "$PNPM_HOME" $PATH
    end
    # pnpm end
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
