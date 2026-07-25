-- hunkdiff.lua — Hunk Diff Viewer
-- Keeps the active file's working-tree diff visible beside the editor as a
-- lightweight review surface. See ~/repos/dotfiles/hunk-diff-spec.md.

local AUGROUP = vim.api.nvim_create_augroup('HunkDiff', { clear = true })

local M = {}

local OPTS = {
  hunk = 'hunk',
  width_ratio = 0.45,
  min_width = 70,
  max_width = 140,
  debounce_ms = 60,
  discover_interval_ms = 200,
  discover_timeout_ms = 30000, -- generous: a contended hunk daemon answers slowly
}

-- singleton state
local S = {}

local function reset_state()
  S = {
    win = nil,
    buf = nil,
    chan = nil,           -- terminal channel / job id
    session_id = nil,
    repo = nil,           -- repo root the launched session reports
    cwd = nil,            -- cwd passed to hunk diff (used for session matching)
    source_buf = nil,     -- last reviewed normal file buffer
    baseline_ids = {},    -- session ids present before launch
    follow_timer = nil,
    discover_timer = nil,
    last_follow_sig = nil,
    last_file = nil,      -- repo-relative path of the file currently reviewed
    closing = false,
  }
end
reset_state()

-- ── small utilities ──────────────────────────────────────────────────────────

local function viewer_visible()
  return S.win ~= nil and vim.api.nvim_win_is_valid(S.win)
end

local function is_normal_buffer(buf)
  if not buf or not vim.api.nvim_buf_is_valid(buf) then return false end
  if vim.bo[buf].buftype ~= '' then return false end
  if vim.bo[buf].filetype == 'hunk-diff' then return false end
  return vim.api.nvim_buf_get_name(buf) ~= ''
end

local function win_width()
  local w = math.floor(vim.o.columns * OPTS.width_ratio)
  w = math.max(OPTS.min_width, math.min(OPTS.max_width, w))
  -- leave room for the source side
  if w > vim.o.columns - 20 then w = math.max(40, vim.o.columns - 20) end
  return w
end

local function repo_root_of(file)
  return vim.fs.root(vim.fs.dirname(file), '.git')
end

local function repo_relative(file_abs, repo)
  if file_abs and repo and vim.startswith(file_abs, repo .. '/') then
    return file_abs:sub(#repo + 2)
  end
  return file_abs
end

local function notify(msg, level)
  vim.notify('HunkDiff: ' .. msg, level or vim.log.levels.WARN)
end

-- Diff subcommand argv scoped to one file, with the common review options.
-- Starts at the `diff` subcommand (NO `hunk` binary prefix) so it can be reused
-- by both the initial launch (which prepends OPTS.hunk) and session reload
-- (which prepends `hunk session reload <id> --`). Sharing this prevents option
-- drift: a reload that drops --no-hunk-headers / --watch would silently regress
-- the panel's chrome and live-update behavior.
local function build_diff_cmd(rel)
  return {
    'diff',
    '--mode', 'stack',
    '--pager',
    '--wrap',
    '--no-hunk-headers',
    '--transparent-bg',
    '--watch',
    '--', rel,
  }
end

-- ── cursor following ─────────────────────────────────────────────────────────

-- silent navigate; viewer stays usable for manual scrolling on failure
local function navigate(rel, line)
  if not S.session_id then return end
  vim.system({ OPTS.hunk, 'session', 'navigate', S.session_id,
    '--file', rel, '--new-line', tostring(line) }, { text = true }, function() end)
end

local function follow_cursor_now()
  if not S.session_id or not S.repo then return end
  local buf = vim.api.nvim_get_current_buf()
  if not is_normal_buffer(buf) then return end
  local rel = repo_relative(vim.api.nvim_buf_get_name(buf), S.repo)
  if not rel or rel == '' or rel ~= S.last_file then return end
  local line = vim.fn.line('.')
  local sig = rel .. ':' .. line
  if sig == S.last_follow_sig then return end
  S.last_follow_sig = sig
  navigate(rel, line)
end

local function schedule_follow()
  if S.follow_timer and not S.follow_timer:is_closing() then
    S.follow_timer:close()
  end
  S.follow_timer = vim.defer_fn(follow_cursor_now, OPTS.debounce_ms)
end

-- reload the live session's diff to a single file (pathspec), then optionally
-- run `cb`. Uses the same common options as the initial launch so the panel's
-- chrome and --watch live-update behavior survive a file switch.
local function reload_session(rel, cb)
  if not S.session_id then return end
  local argv = { OPTS.hunk, 'session', 'reload', S.session_id, '--' }
  for _, a in ipairs(build_diff_cmd(rel)) do table.insert(argv, a) end
  vim.system(argv, { text = true }, function(out)
    vim.schedule(function()
      if out.code ~= 0 then
        -- surface failures: a persistent reload error would otherwise make the
        -- panel silently never update. The viewer stays usable.
        notify('reload failed: ' .. vim.trim(out.stderr or out.stdout or ''),
          vim.log.levels.ERROR)
        return
      end
      S.last_file = rel
      if cb then cb() end
    end)
  end)
end

local function set_winbar(win, file)
  vim.wo[win].winbar = ('Hunk Diff — %s'):format(vim.fn.fnamemodify(file, ':~:.'))
end

-- point the viewer at the current buffer: reload the diff when the file
-- changed, otherwise just follow the cursor
local function review_current_buffer()
  local buf = vim.api.nvim_get_current_buf()
  if not is_normal_buffer(buf) then return end
  S.source_buf = buf
  -- keep winbar in sync with the file being reviewed
  if viewer_visible() then
    set_winbar(S.win, vim.api.nvim_buf_get_name(buf))
  end
  local rel = repo_relative(vim.api.nvim_buf_get_name(buf), S.repo)
  if rel and rel ~= '' and S.last_file ~= rel then
    reload_session(rel, function() navigate(rel, vim.fn.line('.')) end)
  else
    schedule_follow()
  end
end

-- ── session discovery ─────────────────────────────────────────────────────────

local function list_sessions(cb)
  vim.system({ OPTS.hunk, 'session', 'list', '--json' }, { text = true }, function(out)
    -- on_exit runs in a fast event context; defer the consumer callback to the
    -- main loop so it may freely call nvim_* API, vim.fn, vim.bo, termopen, etc.
    vim.schedule(function()
      if out.code ~= 0 then cb(nil) return end
      local ok, d = pcall(vim.json.decode, out.stdout or '')
      if not ok or not d then cb({}) return end
      cb(d.sessions or {})
    end)
  end)
end

local function session_id_of(s)
  return s.sessionId or s.id
end

local function session_match(s)
  -- match the session the plugin created: same cwd and/or same repo
  if S.cwd and s.cwd == S.cwd then return true end
  if S.repo and s.repoRoot and s.repoRoot == S.repo then return true end
  return false
end

local function discover_session()
  if S.session_id then return end
  local elapsed = 0

  local function step()
    list_sessions(function(sessions)
      if not S.buf or S.session_id then return end -- viewer closed/session found
      local new_ones = {}
      for _, s in ipairs(sessions or {}) do
        local id = session_id_of(s)
        if id and not S.baseline_ids[id] then table.insert(new_ones, s) end
      end
      local chosen
      for _, s in ipairs(new_ones) do
        if session_match(s) then chosen = s break end
      end
      if not chosen and #new_ones == 1 then chosen = new_ones[1] end
      if chosen then
        S.session_id = session_id_of(chosen)
        S.repo = S.repo or chosen.repoRoot
        S.cwd = S.cwd or chosen.cwd
        -- resync to whatever buffer is current now: the user may have
        -- switched files while discovery was still polling
        review_current_buffer()
        return
      end
      elapsed = elapsed + OPTS.discover_interval_ms
      if elapsed < OPTS.discover_timeout_ms then
        S.discover_timer = vim.defer_fn(step, OPTS.discover_interval_ms)
      end
    end)
  end
  step()
end

-- ── close ────────────────────────────────────────────────────────────────────

local function close_viewer()
  S.closing = true -- guard against re-entrant TermClose from jobstop below
  if S.follow_timer and not S.follow_timer:is_closing() then S.follow_timer:close() end
  if S.discover_timer and not S.discover_timer:is_closing() then S.discover_timer:close() end
  if S.chan then
    -- `hunk` in $PATH may be a wrapper script that spawns the real hunk
    -- binary as a child; jobstop() signals only the wrapper, which does not
    -- forward the signal — orphaning the session process and its daemon
    -- registration. Terminal jobs are process-group leaders (setsid for the
    -- pty), so TERM the whole process group, then jobstop to reap the job.
    -- jobpid errors with E900 once the job has exited (e.g. TermClose path)
    local ok, pid = pcall(vim.fn.jobpid, S.chan)
    if ok and pid > 0 then
      vim.system({ 'kill', '-TERM', '--', '-' .. pid })
    end
    pcall(vim.fn.jobstop, S.chan)
  end
  if viewer_visible() then vim.api.nvim_win_close(S.win, true) end
  if S.buf and vim.api.nvim_buf_is_valid(S.buf) then
    vim.api.nvim_buf_delete(S.buf, { force = true })
  end
  vim.api.nvim_clear_autocmds({ group = AUGROUP })
  reset_state()
end

-- ── source autocmds (only while viewer visible) ──────────────────────────────

local function setup_source_autocmds()
  vim.api.nvim_clear_autocmds({ group = AUGROUP })

  vim.api.nvim_create_autocmd({ 'CursorMoved', 'CursorMovedI' }, {
    group = AUGROUP,
    callback = function(ev)
      if not viewer_visible() or ev.buf == S.buf then return end
      schedule_follow()
    end,
  })

  vim.api.nvim_create_autocmd({ 'BufEnter', 'BufFilePost' }, {
    group = AUGROUP,
    callback = function(ev)
      if not viewer_visible() or ev.buf == S.buf then return end
      review_current_buffer()
    end,
  })

  vim.api.nvim_create_autocmd('BufWritePost', {
    group = AUGROUP,
    callback = function(ev)
      if not viewer_visible() or ev.buf == S.buf then return end
      -- belt-and-suspenders with --watch: saving the reviewed file reloads its
      -- diff so the panel stays current even if watch misses an event.
      local rel = repo_relative(vim.api.nvim_buf_get_name(ev.buf), S.repo)
      if rel and rel ~= '' and S.last_file == rel then
        reload_session(rel)
      end
    end,
  })

  vim.api.nvim_create_autocmd('TermClose', {
    group = AUGROUP,
    callback = function(ev)
      if ev.buf ~= S.buf or S.closing then return end
      -- hunk process died unexpectedly → tear down cleanly
      close_viewer()
    end,
  })

  vim.api.nvim_create_autocmd('VimResized', {
    group = AUGROUP,
    callback = function()
      if not viewer_visible() then return end
      vim.api.nvim_win_set_width(S.win, win_width())
    end,
  })

  -- entering the viewer window drops straight into terminal mode so keys
  -- reach the Hunk TUI without a manual `i`; leaving restores normal mode
  -- so the source window is not stuck in insert
  vim.api.nvim_create_autocmd({ 'WinEnter', 'BufWinEnter' }, {
    group = AUGROUP,
    callback = function(ev)
      if ev.buf == S.buf then vim.cmd('startinsert') end
    end,
  })

  vim.api.nvim_create_autocmd('WinLeave', {
    group = AUGROUP,
    callback = function(ev)
      if ev.buf == S.buf then vim.cmd('stopinsert') end
    end,
  })
end

-- ── terminal-buffer mappings ────────────────────────────────────────────────

local function setup_terminal_mappings(buf)
  local function map(mode, lhs, rhs)
    vim.keymap.set(mode, lhs, rhs, { buffer = buf, silent = true, nowait = true })
  end
  -- q/r stay plugin keys in both modes; every other key passes through to
  -- the Hunk TUI (j/k/gg/G/C-d/C-u/page/arrows are Hunk's own bindings)
  map('n', 'q', function() M.toggle() end)
  map('n', 'r', function() M.refresh() end)
  map('t', 'q', function() M.toggle() end)
  map('t', 'r', function() M.refresh() end)
  -- Esc: leave terminal mode and enter normal mode (manual scrolling)
  map('t', '<Esc>', '<C-\\><C-n>')
end

-- ── open ─────────────────────────────────────────────────────────────────────

local function apply_window_options(win, file)
  for k, v in pairs({
    number = false,
    relativenumber = false,
    signcolumn = 'no',
    cursorline = false,
    cursorcolumn = false,
    spell = false,
    wrap = false,
    list = false,
    colorcolumn = '',
    foldcolumn = '0',
    foldenable = false,
  }) do
    vim.wo[win][k] = v
  end
  set_winbar(win, file)
end

local function open_viewer()
  local src_buf = vim.api.nvim_get_current_buf()
  if not is_normal_buffer(src_buf) then
    notify('open a file first', vim.log.levels.WARN) return
  end
  if vim.fn.executable(OPTS.hunk) ~= 1 then
    notify('"' .. OPTS.hunk .. '" not found in $PATH', vim.log.levels.ERROR) return
  end
  local file = vim.api.nvim_buf_get_name(src_buf)
  local repo = repo_root_of(file)
  if not repo then
    notify('not inside a git repo', vim.log.levels.WARN) return
  end

  local rel = repo_relative(file, repo)
  if not rel or rel == '' then
    notify('file is not inside the repo', vim.log.levels.WARN) return
  end

  S.repo = repo
  S.cwd = repo
  S.source_buf = src_buf
  S.last_follow_sig = nil
  S.last_file = rel

  -- create the hunk-diff buffer (read-only terminal surface)
  local buf = vim.api.nvim_create_buf(false, true)
  S.buf = buf
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = 'hunk-diff'
  vim.bo[buf].modifiable = false

  -- vertical right split; enter=false keeps the invoking window focused
  local win = vim.api.nvim_open_win(buf, false, {
    vertical = true,
    split = 'right',
    width = win_width(),
  })
  S.win = win
  apply_window_options(win, file)

  -- record the live session ids before the launch so we can isolate the new one
  list_sessions(function(sessions)
    if S.buf ~= buf then return end -- closed meanwhile
    S.baseline_ids = {}
    for _, s in ipairs(sessions or {}) do
      local id = session_id_of(s)
      if id then S.baseline_ids[id] = true end
    end

    -- launch Hunk attached to the viewer buffer. jobstart with term=true
    -- replaces the deprecated vim.fn.termopen. Restrict the diff to the
    -- active file's pathspec so only the reviewed buffer is shown, not the
    -- whole working tree.
    local cmd = { OPTS.hunk }
    for _, a in ipairs(build_diff_cmd(rel)) do table.insert(cmd, a) end
    local chan
    vim.api.nvim_buf_call(buf, function()
      chan = vim.fn.jobstart(cmd, { term = true, cwd = repo })
    end)
    if not chan or chan <= 0 then
      notify('failed to start ' .. OPTS.hunk, vim.log.levels.ERROR)
      close_viewer()
      return
    end
    S.chan = chan
    setup_terminal_mappings(buf)
    setup_source_autocmds()
    discover_session()
  end)
end

M.opts = OPTS

function M.toggle()
  if viewer_visible() then
    close_viewer()
  else
    open_viewer()
  end
end

function M.refresh()
  if not viewer_visible() then
    open_viewer()
    return
  end
  -- anchor the reopen at the previously reviewed file's window if possible,
  -- so a refresh keeps reviewing the same file
  local src_win
  for _, w in ipairs(vim.api.nvim_list_wins()) do
    if w ~= S.win and vim.api.nvim_win_is_valid(w) then
      local buf = vim.api.nvim_win_get_buf(w)
      if is_normal_buffer(buf) then
        if buf == S.source_buf then src_win = w break end
        src_win = src_win or w
      end
    end
  end
  if not src_win then
    notify('open a file first', vim.log.levels.WARN) return
  end
  vim.api.nvim_win_call(src_win, function()
    close_viewer()
    open_viewer()
  end)
end

return M
