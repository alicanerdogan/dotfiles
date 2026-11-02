# Completions for git-worktree

# Helper: list removable worktree names through Git (the branch/dirname part
# after @). The main worktree is always listed first and cannot be removed.
function __git_worktree_list_names
    set -l any_root (git rev-parse --show-toplevel 2>/dev/null)
    or return

    set -l main_repo (git -C "$any_root" worktree list --porcelain 2>/dev/null | string match -r '^worktree (.+)' | string replace 'worktree ' '' | head -n 1)
    or return

    set -l base_name (basename "$main_repo" | string replace -r '@[^@]*$' '')

    set -l paths (git -C "$any_root" worktree list --porcelain 2>/dev/null | string match -r '^worktree (.+)' | string replace 'worktree ' '')
    for path in $paths[2..-1]
        set -l name (basename "$path")
        if string match -q "$base_name@*" -- "$name"
            string replace -r "^$base_name@" '' -- "$name"
        end
    end
end

# Disable default file completions
complete -c git-worktree -f

# Global flags
complete -c git-worktree -s v -l verbose -d 'Enable verbose output'
complete -c git-worktree -s h -l help -d 'Show help'
complete -c git-worktree -l repo -r -F -d 'Operate on the repository at this path'

# Subcommands (only when no subcommand has been given yet)
complete -c git-worktree -n "not __fish_seen_subcommand_from new list remove" -a new    -d 'Create a new git worktree'
complete -c git-worktree -n "not __fish_seen_subcommand_from new list remove" -a list   -d 'List all worktrees'
complete -c git-worktree -n "not __fish_seen_subcommand_from new list remove" -a remove -d 'Remove a worktree'

# remove: complete with existing worktree names and the --force flag
complete -c git-worktree -n "__fish_seen_subcommand_from remove" -a "(__git_worktree_list_names)" -d 'Worktree'
complete -c git-worktree -n "__fish_seen_subcommand_from remove" -s f -l force -d 'Force remove (even with uncommitted changes)'
