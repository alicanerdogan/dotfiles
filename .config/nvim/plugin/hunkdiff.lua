-- Lazy-load stub: defers to require('hunkdiff') on first use.
vim.keymap.set('n', '<leader>gD', function() require('hunkdiff').toggle() end, {
  desc = 'Hunk Diff Viewer: toggle',
})

vim.api.nvim_create_user_command('HunkDiffToggle', function()
  require('hunkdiff').toggle()
end, { desc = 'Hunk Diff Viewer: toggle' })

vim.api.nvim_create_user_command('HunkDiffRefresh', function()
  require('hunkdiff').refresh()
end, { desc = 'Hunk Diff Viewer: restart / manual refresh' })