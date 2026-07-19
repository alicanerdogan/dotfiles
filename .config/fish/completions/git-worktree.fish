# Completions for git-worktree

# Helper: list existing worktree names (the branch/dirname part after @)
function __git_worktree_list_names
    set any_root (git rev-parse --show-toplevel 2>/dev/null)
    or return

    set main_repo (git -C "$any_root" worktree list --porcelain 2>/dev/null | string match -r 'worktree (.+)' | string replace 'worktree ' '' | head -n 1)
    or return

    set base_name (basename "$main_repo" | string replace -r '@[^@]*$' '')
    set parent_dir (dirname "$main_repo")

    for dir in "$parent_dir/$base_name@"*/
        if test -d "$dir"
            basename "$dir" | string replace -r "^$base_name@" ""
        end
    end
end

# Disable default file completions
complete -c git-worktree -f

# Global flags
complete -c git-worktree -s v -l verbose -d 'Enable verbose output'
complete -c git-worktree -s h -l help -d 'Show help'
complete -c git-worktree -l repo -r -d 'Operate on the repository at this path'

# Subcommands (only when no subcommand has been given yet)
complete -c git-worktree -n "not __fish_seen_subcommand_from new list remove" -a new    -d 'Create a new git worktree'
complete -c git-worktree -n "not __fish_seen_subcommand_from new list remove" -a list   -d 'List all worktrees'
complete -c git-worktree -n "not __fish_seen_subcommand_from new list remove" -a remove -d 'Remove a worktree'

# remove: complete with existing worktree names and --force flag
complete -c git-worktree -n "__fish_seen_subcommand_from remove" -a "(__git_worktree_list_names)"
complete -c git-worktree -n "__fish_seen_subcommand_from remove" -s f -l force -d 'Force remove (even with uncommitted changes)'
