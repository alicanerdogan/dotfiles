-- Lazy-load stub: defers to require('review') on first :Review command
vim.api.nvim_create_user_command('Review', function(args)
  require('review').dispatch(args)
end, {
  nargs = '?',
  range = true,
  complete = function() return { 'add', 'edit', 'delete', 'list', 'clear', 'export', 'hunks' } end,
  desc = 'Code review comments: add|edit|delete|list|clear|export|hunks',
})
