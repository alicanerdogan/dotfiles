-- review.lua — lightweight local code review comments inside Git repos
-- Comments stored in .pi/review.jsonl at the repo root

local NS = vim.api.nvim_create_namespace('review')
local AUGROUP = vim.api.nvim_create_augroup('ReviewAuto', { clear = true })

-- Highlight groups — linked to theme groups for adaptive colors
vim.api.nvim_set_hl(0, 'ReviewLine', { link = 'CursorLine', default = true })
vim.api.nvim_set_hl(0, 'ReviewSign', { link = 'DiagnosticInfo', default = true })
vim.api.nvim_set_hl(0, 'ReviewPreview', { link = 'Comment', default = true })

-- ── utilities ────────────────────────────────────────────────────────────────

local function git_root()
  local out = vim.fn.system('git rev-parse --show-toplevel 2>/dev/null')
  if vim.v.shell_error ~= 0 then return nil end
  return vim.trim(out)
end

local function data_path()
  local root = git_root()
  if not root then return nil end
  return root .. '/.pi/review.jsonl'
end

local function relpath(buf)
  local root = git_root()
  if not root then return vim.api.nvim_buf_get_name(buf) end
  local full = vim.api.nvim_buf_get_name(buf)
  -- strip root prefix including the separator
  if vim.startswith(full, root .. '/') then
    return full:sub(#root + 2)
  end
  return full
end

local function uid()
  math.randomseed(vim.fn.reltimefloat(vim.fn.reltime()) * 1000000 + math.random(0, 999999))
  return ('%08x%08x'):format(math.random(0, 0xffffffff), math.random(0, 0xffffffff))
end

local function load_comments()
  local path = data_path()
  if not path then return {} end
  local f = io.open(path, 'r')
  if not f then return {} end
  local comments = {}
  for line in f:lines() do
    if line ~= '' then
      local ok, c = pcall(vim.json.decode, line)
      if ok then
        table.insert(comments, c)
      end
    end
  end
  f:close()
  return comments
end

local function save_comments(comments)
  local path = data_path()
  if not path then return end
  vim.fn.mkdir(vim.fn.fnamemodify(path, ':h'), 'p')
  local f = io.open(path, 'w')
  if not f then
    vim.notify('Review: cannot write to ' .. path, vim.log.levels.ERROR)
    return
  end
  for _, c in ipairs(comments) do
    f:write(vim.json.encode(c) .. '\n')
  end
  f:close()
end

-- ── rendering ────────────────────────────────────────────────────────────────

local function render(buf)
  buf = buf or vim.api.nvim_get_current_buf()
  vim.api.nvim_buf_clear_namespace(buf, NS, 0, -1)

  local file = relpath(buf)
  local comments = load_comments()

  for _, c in ipairs(comments) do
    if c.file == file then
      local sl = c.start_line - 1 -- to 0-indexed
      local el = c.end_line - 1
      local preview = #c.comment > 64 and c.comment:sub(1, 61) .. '…' or c.comment

      -- Sign at the start line only (no range → appears exactly once)
      pcall(vim.api.nvim_buf_set_extmark, buf, NS, sl, 0, {
        sign_text = '💬',
        sign_hl_group = 'ReviewSign',
        priority = 10,
      })
      -- Highlight range + virtual preview text
      pcall(vim.api.nvim_buf_set_extmark, buf, NS, sl, 0, {
        end_row = el + 1,
        end_col = 0,
        hl_group = 'ReviewLine',
        virt_text = { { '  ' .. preview, 'ReviewPreview' } },
        virt_text_pos = 'eol',
        priority = 9,
      })
    end
  end
end

local function refresh_all()
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(b) then
      render(b)
    end
  end
end

-- ── autocommands ─────────────────────────────────────────────────────────────

vim.api.nvim_create_autocmd({ 'BufEnter', 'BufWritePost' }, {
  group = AUGROUP,
  callback = function() render() end,
})

-- ── commands ─────────────────────────────────────────────────────────────────

local function comment_at_cursor()
  local file = relpath(vim.api.nvim_get_current_buf())
  local cl = vim.fn.line('.')
  local comments = load_comments()
  for i, c in ipairs(comments) do
    if c.file == file and cl >= c.start_line and cl <= c.end_line then
      return i, c
    end
  end
  return nil
end

local function add(range_start, range_end)
  local buf = vim.api.nvim_get_current_buf()
  local file = relpath(buf)
  local sl = range_start or vim.fn.line('.')
  local el = range_end or sl
  if sl > el then sl, el = el, sl end

  local lines = vim.api.nvim_buf_get_lines(buf, sl - 1, el, false)
  local snapshot = table.concat(lines, '\n')

  vim.ui.input({ prompt = 'Review comment: ' }, function(input)
    if not input or input == '' then return end
    local comments = load_comments()
    table.insert(comments, {
      id = uid(),
      file = file,
      start_line = sl,
      end_line = el,
      code_snapshot = snapshot,
      comment = input,
      created_at = os.date('!%Y-%m-%dT%H:%M:%SZ'),
      updated_at = os.date('!%Y-%m-%dT%H:%M:%SZ'),
    })
    save_comments(comments)
    render()
  end)
end

local function edit()
  local idx, c = comment_at_cursor()
  if not c then
    vim.notify('Review: no comment at cursor', vim.log.levels.WARN)
    return
  end
  vim.ui.input({ prompt = 'Edit comment: ', default = c.comment }, function(input)
    if not input or input == '' then return end
    local comments = load_comments()
    comments[idx].comment = input
    comments[idx].updated_at = os.date('!%Y-%m-%dT%H:%M:%SZ')
    save_comments(comments)
    render()
  end)
end

local function delete_()
  local idx, c = comment_at_cursor()
  if not c then
    vim.notify('Review: no comment at cursor', vim.log.levels.WARN)
    return
  end
  local comments = load_comments()
  table.remove(comments, idx)
  save_comments(comments)
  refresh_all()
end

local function list()
  local comments = load_comments()
  if #comments == 0 then
    vim.notify('Review: no comments', vim.log.levels.INFO)
    return
  end

  local root = git_root() or ''
  local qf = {}
  for _, c in ipairs(comments) do
    table.insert(qf, {
      filename = root .. '/' .. c.file,
      lnum = c.start_line,
      text = string.format('L%d–L%d: %s', c.start_line, c.end_line, c.comment:gsub('\n', ' ')),
    })
  end

  vim.fn.setqflist({}, 'r', { title = 'Review: ' .. #comments .. ' comment(s)', items = qf })
  vim.cmd.copen()
end

local function clear()
  local path = data_path()
  if path then os.remove(path) end
  refresh_all()
  vim.notify('Review: all comments cleared', vim.log.levels.INFO)
end

local function detect_lang(file)
  local ext = file:match('%.(%w+)$')
  if not ext then return '' end
  local map = {
    lua = 'lua', py = 'python', js = 'javascript', ts = 'typescript',
    jsx = 'jsx', tsx = 'tsx', svelte = 'svelte', vue = 'vue',
    rs = 'rust', go = 'go', c = 'c', cpp = 'cpp', h = 'c',
    css = 'css', scss = 'scss', html = 'html', md = 'markdown',
    json = 'json', yml = 'yaml', yaml = 'yaml', toml = 'toml',
    sql = 'sql', sh = 'bash', bash = 'bash', zsh = 'bash',
  }
  return map[ext] or ''
end

local function export()
  local comments = load_comments()
  if #comments == 0 then
    vim.notify('Review: no comments to export', vim.log.levels.WARN)
    return
  end

  local by_file = {}
  local order = {}
  for _, c in ipairs(comments) do
    if not by_file[c.file] then
      by_file[c.file] = {}
      table.insert(order, c.file)
    end
    table.insert(by_file[c.file], c)
  end

  local md = { '# Code Review Comments\n' }
  for _, file in ipairs(order) do
    table.insert(md, '## `' .. file .. '`\n')
    local lang = detect_lang(file)
    for _, c in ipairs(by_file[file]) do
      local line_label = c.start_line == c.end_line
        and ('L' .. c.start_line)
        or ('L%d–L%d'):format(c.start_line, c.end_line)
      table.insert(md, string.format('- **%s**: %s\n', line_label, c.comment:gsub('\n', ' ')))
      if c.code_snapshot and c.code_snapshot ~= '' then
        table.insert(md, '')
        table.insert(md, '  ```' .. lang)
        for _, snapshot_line in ipairs(vim.split(c.code_snapshot, '\n')) do
          table.insert(md, '  ' .. snapshot_line)
        end
        table.insert(md, '  ```')
        table.insert(md, '')
      end
    end
  end

  local out = table.concat(md, '\n')
  vim.fn.setreg('+', out)
  vim.notify('Review: ' .. #comments .. ' comment(s) copied as Markdown', vim.log.levels.INFO)
end

local function hunks()
  local out = vim.fn.system('git diff --no-ext-diff --unified=0')
  if vim.v.shell_error ~= 0 or out == '' then
    vim.notify('Review: no unstaged changes', vim.log.levels.INFO)
    return
  end

  local qf = {}
  local file = nil
  for line in out:gmatch('[^\n]+') do
    -- Match --- a/filename (default prefix) or --- filename (noprefix)
    local f = line:match('^%-%-%- a/(.+)') or line:match('^%-%-%- (.+)')
    if f then
      file = f
    elseif file then
      local lnum = line:match('^@@ %-(%d+)')
      if lnum then
        table.insert(qf, { filename = file, lnum = tonumber(lnum), text = line })
      end
    end
  end

  if #qf == 0 then
    vim.notify('Review: no hunks found', vim.log.levels.INFO)
    return
  end

  vim.fn.setqflist({}, 'r', { title = 'Review: unstaged hunks', items = qf })
  vim.cmd.copen()
end

-- ── module dispatch (called from plugin/review.lua stub) ─────────────────────

local M = {}

function M.dispatch(args)
  local sub = args.args or ''

  if sub == '' or sub == 'add' then
    if args.range > 0 then
      add(args.line1, args.line2)
    else
      add()
    end
  elseif sub == 'edit' then
    edit()
  elseif sub == 'delete' then
    delete_()
  elseif sub == 'list' then
    list()
  elseif sub == 'clear' then
    clear()
  elseif sub == 'export' then
    export()
  elseif sub == 'hunks' then
    hunks()
  else
    vim.notify('Review: unknown subcommand "' .. sub .. '"', vim.log.levels.ERROR)
  end
end

return M
