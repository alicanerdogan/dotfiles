local theme = 'dark'
local function set_theme()
  if theme == 'dark' then
    vim.cmd('colorscheme terafox')
  else
    vim.cmd('colorscheme dayfox')
  end
end

-- Utility functions
local user_module = nil
local function get_user_module()
  if user_module ~= nil then
    return user_module
  end

  local status, module = pcall(require, "user")

  if status then
    user_module = module
    return module
  else
    return nil
  end
end

local function did_editor_open_with_directory()
  local args = vim.fn.argv()
  if #args < 1 then
    return false
  end
  local Path = require('plenary.path')
  local path = Path:new({ args[1] }):absolute()
  local cwd = Path:new({ vim.loop.cwd() }):absolute()

  return path == cwd and vim.fn.isdirectory(path) > 0
end

local function get_root_directory()
  local args = vim.fn.argv()
  if #args < 1 then
    return nil
  end


  local Path = require('plenary.path')
  local path = Path:new({ args[1] }):absolute()

  if vim.fn.isdirectory(path) > 0 then
    return path
  else
    return nil
  end
end

local function file_exists(path)
  local f = io.open(path, "r")
  if f ~= nil then
    io.close(f)
    return true
  else
    return false
  end
end

local function get_biome_path()
  local root_dir = get_root_directory()
  if root_dir == nil then
    return nil
  end
  return root_dir .. '/node_modules/.bin/biome'
end

local function get_prettier_path()
  local root_dir = get_root_directory()
  if root_dir == nil then
    return nil
  end
  return root_dir .. '/node_modules/.bin/prettier'
end

local function get_sql_formatter_path()
  local root_dir = get_root_directory()
  if root_dir == nil then
    return nil
  end
  return root_dir .. '/node_modules/.bin/sql-formatter'
end

local function biome_exists()
  local biome_path = get_biome_path()
  if biome_path == nil then
    return false
  end
  return file_exists(biome_path)
end

local function prettier_exists()
  local prettier_path = get_prettier_path()
  if prettier_path == nil then
    return false
  end
  return file_exists(prettier_path)
end

local function sql_formatter_exists()
  local sql_formatter_path = get_sql_formatter_path()
  if sql_formatter_path == nil then
    return false
  end
  return file_exists(sql_formatter_path)
end

local function run_async_command(command, on_complete)
  local stdout_data = {}
  local stderr_data = {}

  local job_id = vim.fn.jobstart(command, {
    on_stdout = function(_, data)
      for _, line in ipairs(data) do
        if line ~= "" then
          table.insert(stdout_data, line)
        end
      end
    end,
    on_stderr = function(_, data)
      for _, line in ipairs(data) do
        if line ~= "" then
          table.insert(stderr_data, line)
        end
      end
    end,
    on_exit = function(_, code)
      if on_complete then
        on_complete({
          success = code == 0,
          code = code,
          stdout = table.concat(stdout_data, "\n"),
          stderr = table.concat(stderr_data, "\n"),
        })
      end
    end,
  })

  return job_id
end

local resize_windows = function()
  local current_tab = vim.api.nvim_get_current_tabpage()
  vim.cmd("tabdo wincmd =")
  vim.api.nvim_set_current_tabpage(current_tab)
end
-- Utility functions end

local function set_up_global_config()
  vim.opt.scrolloff = 8
  vim.opt.number = true         -- show line numbers
  vim.opt.relativenumber = true
  vim.opt.tabstop = 2           -- number of spaces to a TAB counts for
  vim.opt.softtabstop = 2
  vim.opt.shiftwidth = 2        -- number of spaces a use for each step of indent
  vim.opt.expandtab = true      -- expand tabs into spaces
  vim.opt.smartindent = true
  vim.opt.cursorline = true     -- Adds a highlight to the current line
  vim.opt.virtualedit = "block" -- Allow cursor to move where there is no text in visual block mode
  vim.opt.cmdheight = 0         -- Hide the command line when it is not active

  -- Set filetype to `bigfile` for files larger than 1MB
  -- Only vim syntax will be enabled (with the correct filetype)
  -- LSP, treestitter and the other ft plugins will be disabled.
  vim.g.bigfile_size = 1024 * 1024 * 1
  vim.filetype.add({
    pattern = {
      [".*"] = {
        function(path, buf)
          return vim.bo[buf].filetype ~= "bigfile" and path and vim.fn.getfsize(path) > vim.g.bigfile_size and "bigfile" or
              nil
        end,
      },
    },
  })
  vim.api.nvim_create_autocmd({ "FileType", }, {
    group = vim.api.nvim_create_augroup("bigfile", { clear = true }),
    pattern = "bigfile",
    callback = function(ev)
      vim.b.minianimate_disable = true
      vim.schedule(function()
        vim.bo[ev.buf].syntax = vim.filetype.match({ buf = ev.buf }) or ""
      end)
    end,
  })

  vim.api.nvim_create_autocmd({ "VimResized" }, {
    group = vim.api.nvim_create_augroup("EqualizeSplits", {}),
    callback = resize_windows,
    desc = "Resize splits with terminal window",
  })

  local os_uname = vim.loop.os_uname().sysname
  if os_uname == "Darwin" then
    vim.opt.clipboard = 'unnamed'
  else
    -- For linux
    vim.opt.clipboard = 'unnamedplus'
  end

  -- Open vertical splits to the right of the current window
  vim.opt.splitright = true
  -- disable netrw in favor of nvim-tree
  vim.g.loaded_netrw = 1
  vim.g.loaded_netrwPlugin = 1
  vim.g.markdown_fenced_languages = {
    "ts=typescript"
  }

  vim.g.mapleader = ' '
end

local function set_up_nvim_only_config()
  vim.opt.termguicolors = true
  vim.opt.pumheight = 10 -- Sets the numver of items in the popup menu

  vim.api.nvim_create_user_command('PasteInline',
    function()
      local reg_value = vim.fn.getreg('"')
      reg_value = string.gsub(reg_value, "^%s+", "")
      reg_value = string.gsub(reg_value, "%s+$", "")
      -- Set the register 'a' with your desired string
      vim.fn.setreg('a', reg_value)
      -- Paste the contents of register 'a' at the cursor position in your buffer
      vim.api.nvim_command("normal! \"ap")
    end,
    { nargs = 0 })

  -- Copy relative path of current file to clipboard
  vim.api.nvim_create_user_command('CopyRelPath',
    function()
      vim.api.nvim_call_function("setreg", { "+", vim.fn.fnamemodify(vim.fn.expand("%"), ":.") })
    end,
    { nargs = 0 })

  -- Copy github permalink of the current file to clipboard
  vim.api.nvim_create_user_command('CopyGithubPermalink',
    function()
      local relative_path = vim.fn.fnamemodify(vim.fn.expand("%"), ":.")
      run_async_command("gh browse " .. relative_path .. " --no-browser --commit=$(git rev-parse HEAD)",
        function(result)
          if result.success then
            vim.api.nvim_call_function("setreg", { "+", result.stdout })
          else
            print("Failed to copy github permalink")
            print(result.stderr)
          end
        end)
    end,
    { nargs = 0 })

  -- Copy github permalink of the current line to clipboard
  vim.api.nvim_create_user_command('CopyGithubPermalinkLine',
    function()
      local relative_path = vim.fn.fnamemodify(vim.fn.expand("%"), ":.")
      local line_number = vim.fn.line(".")
      run_async_command(
        "gh browse " .. relative_path .. ":" .. line_number .. " --no-browser --commit=$(git rev-parse HEAD)",
        function(result)
          if result.success then
            vim.api.nvim_call_function("setreg", { "+", result.stdout })
          else
            print("Failed to copy github permalink line")
            print(result.stderr)
          end
        end)
    end,
    { nargs = 0 })

  -- Toggle terminal only if it is not open, otherwise just select open terminal window
  vim.api.nvim_create_user_command('SmartToggleTerm',
    function()
      local term_buff_name_postfix = "#toggleterm#1"
      local get_term_window = function()
        for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
          for _, win in pairs(vim.api.nvim_tabpage_list_wins(tab)) do
            local buf = vim.api.nvim_win_get_buf(win)
            local buffName = vim.api.nvim_buf_get_name(buf)
            if vim.endswith(buffName, term_buff_name_postfix) then
              return win
            end
          end
        end
        return nil
      end

      local current_buffer_name = vim.api.nvim_buf_get_name(0)
      if vim.endswith(current_buffer_name, term_buff_name_postfix) then
        vim.cmd(':ToggleTerm')
        resize_windows()
        return
      end

      local win = get_term_window()
      if win == nil then
        local neotree_is_active = vim.endswith(current_buffer_name, 'neo-tree filesystem [1]')
        if neotree_is_active then
          vim.cmd(':Neotree close')
        end
        -- activate the terminal
        vim.cmd(':ToggleTerm')
        resize_windows()
        return
      else
        -- pick the terminal
        vim.api.nvim_set_current_win(win)
        return
      end
    end,
    { nargs = 0 })

  -- Switch theme to dark or light (pass argument to switch to a specific theme)
  vim.api.nvim_create_user_command('SwitchTheme',
    function(opts)
      local new_theme = opts.args
      if new_theme ~= "dark" and new_theme ~= "light" then
        print("Invalid theme. Please use 'dark' or 'light'")
        return
      end
      theme = new_theme
      set_theme()
    end,
    { nargs = 1 })
end

local function set_up_vscode_config()
end

local function set_up_config()
  local user = get_user_module()

  set_up_global_config()
  if user ~= nil then
    user.set_up_global_config()
  end
  if vim.g.vscode then
    set_up_vscode_config()
    if user ~= nil then
      user.set_up_vscode_config()
    end
  else
    if user ~= nil then
      user.set_up_nvim_only_config()
    end
    set_up_nvim_only_config()
  end
end

---------------------

local function set_up_global_plugins(plugins)
  table.insert(plugins, {
    "echasnovski/mini.ai",
    version = '*',
    config = function()
      local MiniAI = require("mini.ai")
      MiniAI.setup({
        custom_textobjects = {
          D = MiniAI.gen_spec.treesitter({ a = '@assignment.outer', i = '@assignment.inner' }),
        }
      })
    end,
  })
  table.insert(plugins, {
    "echasnovski/mini.surround",
    version = '*',
    config = function()
      require("mini.surround").setup()
    end,
  })
  table.insert(plugins, {
    "folke/ts-comments.nvim",
    opts = {},
    event = "VeryLazy",
    enabled = vim.fn.has("nvim-0.10.0") == 1,
  })
end

local function set_up_nvim_only_plugins(plugins)
  table.insert(plugins, {
    "nvim-lualine/lualine.nvim",
    dependencies = { 'nvim-tree/nvim-web-devicons' },
    config = function()
      local condFn = function()
        local ft = vim.bo.filetype
        local blocklist = { 'toggleterm' }
        for _, v in ipairs(blocklist) do
          if ft == v then
            return false
          end
        end
        return true
      end
      require("lualine").setup({
        options = {
          disabled_filetypes = { 'neo-tree', 'DiffviewFiles' },
        },
        sections = {
          lualine_c = {
            {
              'filename',
              file_status = true, -- displays file status (readonly status, modified status)
              path = 1,           -- 0 = just filename, 1 = relative path, 2 = absolute path
              cond = condFn,
            }
          },
          lualine_x = {
            {
              'filetype',
              cond = condFn,
            }
          },
          lualine_y = {
            {
              'searchcount',
              cond = condFn,
            }
          },
          lualine_z = {
            {
              'location',
              cond = condFn,
            }
          },
        },
        inactive_sections = {
          lualine_c = {
            {
              'filename',
              file_status = true, -- displays file status (readonly status, modified status)
              path = 1            -- 0 = just filename, 1 = relative path, 2 = absolute path
            },
          },
        },
      })
    end,
  })
  table.insert(plugins, {
    "ibhagwan/fzf-lua",
    dependencies = {
      "nvim-tree/nvim-web-devicons",
    },
    config = function()
      require("fzf-lua").setup({
        files = {
          formatter = "path.filename_first",
        },
        grep = {
          formatter = "path.filename_first",
          actions = {
            ["ctrl-q"] = {
              -- Send results to the quickfix list
              fn = require("fzf-lua").actions.file_edit_or_qf,
              prefix = "select-all+",
            },
            ["ctrl-c"] = {
              fn = function()
                -- TODO: clear search query
              end,
            },
          },
        },
        glob = {
          formatter = "path.filename_first",
          rg_glob = true,
          -- first returned string is the new search query
          -- second returned string are (optional) additional rg flags
          -- @return string, string?
          rg_glob_fn = function(query, opts)
            local regex, flags = query:match("^(.-)%s%-%-(.*)$")
            -- If no separator is detected wil return the original query
            return (regex or query), flags
          end,
        }
      })
      -- searching within git tracked files
      vim.keymap.set('n', '<C-p>', function() require('fzf-lua').files({ cwd_prompt = false, previewer = false }) end,
        { noremap = true, desc = "Find files in the current directory" })
      -- searching with git tracked files
      vim.keymap.set('n', '<leader>ff', function()
          require('fzf-lua').live_grep_glob({
            no_esc = true,
            search = " -- !*.test.html !*.test.ts !*.spec.ts !*.md !*.graphql !*.json !*.lock !*.mock",
            winopts = {
              preview = {
                delay = 500,
              },
              on_create = function()
                -- synthetically press ctrl-a to move the cursor to the beginning of the line
                vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<C-a>", true, true, true), "n", true)
              end,
            }
          })
        end,
        { noremap = true, desc = "Search in current directory" })
      -- searching the word under the cursor within git tracked files
      vim.keymap.set('n', '<leader>fg', function() require('fzf-lua').grep_cword() end,
        { noremap = true, desc = "search current word in current directory" })
      vim.keymap.set('v', '<leader>fg', function() require('fzf-lua').grep_cword() end,
        { noremap = true, desc = "search current word in current directory" })
      -- searching symbols in the document
      vim.keymap.set('n', '<leader>fs', function() require('fzf-lua').treesitter({ previewer = false }) end,
        { noremap = true, desc = "Search symbols in the buffer" })
      -- searching symbols in the workspace
      vim.keymap.set('n', '<leader>fws',
        function() require('fzf-lua').lsp_live_workspace_symbols({ previewer = false }) end,
        { noremap = true, desc = "Search symbols in the current directory" })
      -- searching within recent files
      vim.keymap.set('n', '<leader>fr',
        function() require('fzf-lua').oldfiles({ cwd = get_root_directory(), previewer = false }) end,
        { noremap = true, desc = "Search in recent files" })
      -- searching within modified files
      vim.keymap.set('n', '<leader>fm', function() require('fzf-lua').git_status() end,
        { noremap = true, desc = "Search in modified files" })
    end,
  })

  table.insert(plugins, {
    "EdenEast/nightfox.nvim",
    lazy = false,
    priority = 1000,
    config = set_theme,
  })

  table.insert(plugins, {
    "3rd/image.nvim",
    enabled = vim.env.TMUX == nil,
    opts = {},
    config = function()
      require("image").setup({
        backend = "kitty",
        processor = "magick_cli",
        integrations = {
          markdown = {
            enabled = true,
            clear_in_insert_mode = false,
            download_remote_images = true,
            only_render_image_at_cursor = false,
          },
        },
        max_width_window_percentage = 100,
        max_height_window_percentage = 100,
        window_overlap_clear_enabled = true,
        scale_factor = 3.0,
      })
    end,
  })

  table.insert(plugins, {
    "nvim-neo-tree/neo-tree.nvim",
    branch = "v3.x",
    dependencies = {
      "nvim-lua/plenary.nvim",
      "nvim-tree/nvim-web-devicons",
      "MunifTanjim/nui.nvim",
    },
    config = function()
      require("neo-tree").setup({
        filesystem = {
          filtered_items = {
            hide_dotfiles = false,
          },
        },
        default_component_configs = {
          file_size = {
            enabled = false,
          },
          type = {
            enabled = false,
          },
          last_modified = {
            enabled = false,
          },
          created = {
            enabled = false,
          },
        },
        window = {
          position = "left",
          width = 80,
          mappings = {
            ["<c-v>"] = "open_vsplit",
          },
        },
      })

      -- Exit NvimTree when the active buffer changes
      vim.api.nvim_create_autocmd({ "BufLeave", "BufWinLeave" }, {
        pattern = "neo-tree *",
        callback = function()
          local tree_wins = {}
          local floating_wins = {}
          local wins = vim.api.nvim_list_wins()
          for _, w in ipairs(wins) do
            local bufname = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(w))
            if vim.api.nvim_win_get_config(w).relative ~= '' then
              table.insert(floating_wins, w)
            elseif bufname:match("neo-tree ") == nil then
              table.insert(tree_wins, w)
            end
          end
          if #tree_wins > 0 then
            -- Should quit, so we close all invalid windows.
            vim.cmd(':Neotree close')
          end
        end
      })
    end
  })

  table.insert(plugins, {
    'akinsho/toggleterm.nvim',
    version = "*",
    config = function()
      require("toggleterm").setup({
        size = function(term)
          if term.direction == "horizontal" then
            return 15
          elseif term.direction == "vertical" then
            local val = vim.o.columns * 0.4
            local min = 80
            local max = 140
            return math.max(min, math.min(max, val))
          end
        end,
        start_in_insert = true,
        persist_mode = false,
        persist_size = false,
        direction = 'vertical',
        close_on_exit = true, -- close the terminal window when the process exits
        -- Change the default shell. Can be a string or a function returning a string
        shell = function()
          if not did_editor_open_with_directory() then
            return 'zsh'
          end

          local cwd = vim.fn.getcwd()
          -- Remove trailing slash if exists
          if string.sub(cwd, -1) == "/" then
            cwd = string.sub(cwd, 1, -2)
          end

          -- Split the path using directory separator ("/" or "\")
          local segments = {}
          for segment in string.gmatch(cwd, "([^\\/]+)") do
            table.insert(segments, segment)
          end
          vim.inspect(segments)

          -- Get the last segment as folder name
          local folderName = segments[#segments]

          local tmux_path = ""
          local os_uname = vim.loop.os_uname().sysname
          if os_uname == "Darwin" then
            tmux_path = "/opt/homebrew/bin/tmux"
          else
            -- For linux
            tmux_path = "/home/linuxbrew/.linuxbrew/bin/tmux"
          end
          return tmux_path .. " new -ADs vs-" .. folderName
        end,
        auto_scroll = true, -- automatically scroll to the bottom on terminal output
        shading_factor = 0, -- set background shade to 0
      })

      function _G.set_terminal_keymaps()
        local opts = { buffer = 0 }
        vim.keymap.set('t', '<C-t>', [[<Cmd>:SmartToggleTerm<CR>]], opts)
        vim.keymap.set('t', '<C-h>', [[<Cmd>wincmd h<CR>]], opts)
        vim.keymap.set('t', '<C-j>', [[<Cmd>wincmd j<CR>]], opts)
        vim.keymap.set('t', '<C-k>', [[<Cmd>wincmd k<CR>]], opts)
        vim.keymap.set('t', '<C-l>', [[<Cmd>wincmd l<CR>]], opts)
        vim.keymap.set('t', '<C-w>', [[<C-\><C-n><C-w>]], opts)
      end

      -- set keymaps when terminal open
      local termGroup = vim.api.nvim_create_augroup("openTermInsert", {})
      vim.api.nvim_create_autocmd({ "TermOpen" }, {
        group = termGroup,
        pattern = "term://*toggleterm#*",
        callback = set_terminal_keymaps,
      })
      vim.api.nvim_create_autocmd({ "BufEnter", "BufWinEnter" }, {
        group = termGroup,
        pattern = "term://*toggleterm#*",
        callback = function()
          vim.cmd("startinsert")
        end,
      })
    end,
  })

  table.insert(plugins, {
    'nvim-treesitter/nvim-treesitter',
    dependencies = {
      'nvim-treesitter/nvim-treesitter-textobjects',
      'windwp/nvim-ts-autotag',
    },
    build = ":TSUpdate",
    config = function()
      require('nvim-treesitter.configs').setup({
        ensure_installed = {
          'lua',
          'vimdoc',
          'vim',
          'bash',
          'markdown',
          'markdown_inline',
          'javascript',
          'typescript',
          'tsx',
          'css',
          'html',
        },
        indent = { enable = true },
        incremental_selection = {
          enable = true,
          keymaps = {
            init_selection = "<leader>ni",    -- ([n]ode [i]nit) maps in normal mode to init the node/scope selection with space
            node_incremental = "<leader>ne",  -- ([n]ode [e]xpand) increment to the upper named parent
            node_decremental = "<leader>nd",  -- ([n]ode [d]ecrement) decrement to the previous node
            scope_incremental = "<leader>ns", -- ([n]ode [s]cope) increment to the upper scope (as defined in locals.scm)
          },
        },
        autotag = {
          enable = true,
          enable_close_on_slash = false,
          filetypes = {
            'html', 'javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'svelte', 'vue', 'tsx', 'jsx',
            'rescript',
            'css', 'lua', 'xml', 'php', 'markdown'
          },
        },
        autopairs = {
          enable = true,
        },
        highlight = {
          enable = true,

          -- Disable slow treesitter highlight for large files
          disable = function(lang, buf)
            local max_filesize = 100 * 1024 -- 100 KB
            local ok, stats = pcall(vim.loop.fs_stat, vim.api.nvim_buf_get_name(buf))
            if ok and stats and stats.size > max_filesize then
              return true
            end
          end,

          -- Setting this to true will run `:h syntax` and tree-sitter at the same time.
          -- Set this to `true` if you depend on 'syntax' being enabled (like for indentation).
          -- Using this option may slow down your editor, and you may see some duplicate highlights.
          -- Instead of true it can also be a list of languages
          additional_vim_regex_highlighting = false,
        },
        textobjects = {
          select = {
            enable = true,
            lookahead = true, -- Automatically jump forward to textobj, similar to targets.vim
            keymaps = {
              -- You can use the capture groups defined in textobjects.scm
              ['aa'] = '@parameter.outer',
              ['ia'] = '@parameter.inner',
              ['af'] = '@function.outer',
              ['if'] = '@function.inner',
              ['ac'] = '@class.outer',
              ['ic'] = '@class.inner',
              ["iB"] = "@block.inner",
              ["aB"] = "@block.outer",
            },
          },
          move = {
            enable = true,
            set_jumps = true, -- whether to set jumps in the jumplist
            goto_next_start = {
              [']]'] = '@function.outer',
            },
            goto_next_end = {
              [']['] = '@function.outer',
            },
            goto_previous_start = {
              ['[['] = '@function.outer',
            },
            goto_previous_end = {
              ['[]'] = '@function.outer',
            },
          },
          swap = {
            enable = true,
            swap_next = {
              ['<leader>sn'] = '@parameter.inner',
            },
            swap_previous = {
              ['<leader>sp'] = '@parameter.inner',
            },
          },
        },
      })
    end,
  })

  table.insert(plugins, {
    "L3MON4D3/LuaSnip",
    -- follow latest release.
    version = "2.*", -- Replace <CurrentMajor> by the latest released major (first number of latest release)
    build = "make install_jsregexp",
    config = function()
      require("luasnip.loaders.from_vscode").lazy_load({ paths = { "./snippets" } })
    end,
  })

  table.insert(plugins, {
    'saghen/blink.cmp',
    version = 'v0.*',
    dependencies = {
      { 'L3MON4D3/LuaSnip', version = 'v2.*' },
    },
    opts = {
      keymap = {
        preset = 'super-tab',
      },
      appearance = {
        nerd_font_variant = 'mono',
      },
      sources = {
        default = { 'lsp', 'path', 'snippets' }
      },
      snippets = {
        expand = function(snippet) require('luasnip').lsp_expand(snippet) end,
        active = function(filter)
          if filter and filter.direction then
            return require('luasnip').jumpable(filter.direction)
          end
          return require('luasnip').in_snippet()
        end,
        jump = function(direction)
          require('luasnip').jump(direction)
        end,
      },
      completion = {
        documentation = {
          auto_show = true,
        },
      },
    },
    opts_extend = {
      "sources.default",
    },
  })
  table.insert(plugins, {
    'neovim/nvim-lspconfig',
    dependencies = {
      -- LSP Support
      { 'williamboman/mason.nvim' },
      { 'williamboman/mason-lspconfig.nvim' },

      -- Autocompletion
      {
        'saghen/blink.cmp',
        version = 'v0.*',
      },
      {
        'L3MON4D3/LuaSnip',
        version = 'v2.*',
      },
    },
    config = function()
      local lspconfig = require('lspconfig')
      -- Reserve a space in the gutter
      vim.opt.signcolumn = 'yes'

      require('mason').setup({})
      ---@diagnostic disable-next-line: missing-fields
      require('mason-lspconfig').setup({
        ensure_installed = { 'lua_ls', 'ts_ls', 'eslint' },
        handlers = {
          function(server_name)
            local capabilities = require('blink.cmp').get_lsp_capabilities()
            lspconfig[server_name].setup({
              capabilities = capabilities,
            })
          end,
          lua_ls = function()
            local capabilities = require('blink.cmp').get_lsp_capabilities()
            lspconfig.lua_ls.setup({
              capabilities = capabilities,
              settings = {
                Lua = {
                  runtime = {
                    version = 'LuaJIT',
                  },
                  diagnostics = {
                    globals = {
                      'vim',
                      'require',
                    },
                  },
                  workspace = {
                    library = vim.api.nvim_get_runtime_file("", true),
                  },
                  telemetry = {
                    enable = false,
                  },
                },
              },
            })
          end,
          ts_ls = function()
            local capabilities = require('blink.cmp').get_lsp_capabilities()
            lspconfig.ts_ls.setup({
              capabilities = capabilities,
              on_init = function()
                lspconfig.ts_ls.setup({
                  handlers = {
                    -- When using ts_ls, go to definition should open the first result and ignore the others in the list
                    ["textDocument/definition"] = function(err, result, ...)
                      result = vim.tbl_islist(result) and result[1] or result
                      vim.lsp.handlers["textDocument/definition"](err, result, ...)
                    end,
                  },
                })
              end,
            })
          end,
        }
      })

      if biome_exists() then
        local biome_path = get_biome_path()
        lspconfig.biome.setup({ cmd = { biome_path, 'lsp-proxy' } })
      end
    end
  })

  table.insert(plugins, {
    'mhartington/formatter.nvim',
    config = function()
      local format = require("formatter")

      local formatter = nil
      if biome_exists() then
        formatter = function()
          return {
            exe = get_biome_path(),
            args = { "format", "--stdin-file-path", vim.fn.shellescape(vim.api.nvim_buf_get_name(0)) },
            stdin = true,
          }
        end
      elseif prettier_exists() then
        formatter = function()
          return {
            exe = get_prettier_path(),
            args = { "--stdin-filepath", vim.fn.shellescape(vim.api.nvim_buf_get_name(0)) },
            stdin = true,
          }
        end
      end

      local sql_formatter = nil
      if sql_formatter_exists() then
        sql_formatter = function()
          return {
            exe = get_sql_formatter_path(),
            args = { "--language", "sqlite" },
            stdin = true,
          }
        end
      end

      local settings = {}
      if formatter ~= nil then
        settings = {
          css = { formatter },
          scss = { formatter },
          html = { formatter },
          javascript = { formatter },
          javascriptreact = { formatter },
          typescript = { formatter },
          typescriptreact = { formatter },
          markdown = { formatter },
          json = { formatter },
          jsonc = { formatter },
          sql = { sql_formatter },
        }
      end

      format.setup {
        logging = false,
        filetype = settings,
      }

      -- format on save
      vim.api.nvim_exec(
        [[
      augroup FormatAutogroup
        autocmd!
        autocmd BufWritePost *.js,*.jsx,*.ts,*.tsx,*.html,*css,*json,*.md FormatWrite
      augroup END
      ]],
        true
      )

      vim.keymap.set("n", "<leader>rf", function()
        if settings[vim.bo.filetype] ~= nil then
          vim.cmd([[Format]])
        else
          vim.lsp.buf.format()
        end
      end, { desc = "Format buffer" })
    end,
  })

  table.insert(plugins, {
    "folke/which-key.nvim",
    event = "VeryLazy",
    opts = {
      preset = "modern",
    }
  })

  table.insert(plugins, {
    "lewis6991/gitsigns.nvim",
    dependencies = {
      'sindrets/diffview.nvim'
    },
    config = function()
      vim.keymap.set('n', '<leader>gh', ':DiffviewFileHistory %<CR>', { desc = "Git: Show file history" })
      vim.api.nvim_create_user_command('ToggleDiffview',
        function()
          local currentTab = vim.api.nvim_get_current_tabpage()
          for _, win in pairs(vim.api.nvim_tabpage_list_wins(currentTab)) do
            local buf = vim.api.nvim_win_get_buf(win)
            local buffName = vim.api.nvim_buf_get_name(buf)
            if vim.startswith(buffName, "diffview://") or vim.endswith(buffName, "DiffviewFilePanel") then
              vim.cmd("tabclose")
              return
            end
          end
          vim.cmd(":DiffviewOpen")
        end,
        { nargs = 0 })

      require('gitsigns').setup {
        signs                        = {
          add          = { text = '│' },
          change       = { text = '│' },
          delete       = { text = '_' },
          topdelete    = { text = '‾' },
          changedelete = { text = '~' },
          untracked    = { text = '┆' },
        },
        signcolumn                   = true,  -- Toggle with `:Gitsigns toggle_signs`
        numhl                        = false, -- Toggle with `:Gitsigns toggle_numhl`
        linehl                       = false, -- Toggle with `:Gitsigns toggle_linehl`
        word_diff                    = false, -- Toggle with `:Gitsigns toggle_word_diff`
        watch_gitdir                 = {
          follow_files = true
        },
        attach_to_untracked          = true,
        current_line_blame           = false, -- Toggle with `:Gitsigns toggle_current_line_blame`
        current_line_blame_opts      = {
          virt_text = true,
          virt_text_pos = 'eol', -- 'eol' | 'overlay' | 'right_align'
          delay = 1000,
          ignore_whitespace = false,
        },
        current_line_blame_formatter = '<author>, <author_time:%Y-%m-%d> - <summary>',
        sign_priority                = 6,
        update_debounce              = 100,
        status_formatter             = nil,   -- Use default
        max_file_length              = 40000, -- Disable if file is longer than this (in lines)
        preview_config               = {
          -- Options passed to nvim_open_win
          border = 'single',
          style = 'minimal',
          relative = 'cursor',
          row = 0,
          col = 1
        },
        on_attach                    = function(bufnr)
          local gs = package.loaded.gitsigns

          local function map(mode, l, r, opts)
            opts = opts or {}
            opts.buffer = bufnr
            vim.keymap.set(mode, l, r, opts)
          end

          map('n', '<leader>jh', function()
            if vim.wo.diff then return '<leader>jh' end
            vim.schedule(function() gs.next_hunk() end)
            return '<Ignore>'
          end, { expr = true, desc = "Jump to next diff" })

          map('n', '<leader>jH', function()
            if vim.wo.diff then return '<leader>jH' end
            vim.schedule(function() gs.prev_hunk() end)
            return '<Ignore>'
          end, { expr = true, desc = "Jump to prev diff" })

          -- Actions
          map('n', '<leader>gs', gs.stage_hunk, { desc = "Git: Stage the diff" })
          map('n', '<leader>gS', gs.stage_buffer, { desc = "Git: Stage the buffer" })
          map('n', '<leader>glb', function() gs.blame_line { full = true } end, { desc = "Git: Blame line" })
          map('n', '<leader>gb', gs.toggle_current_line_blame, { desc = "Git: Toggle blame line" })
          map('n', '<leader>gd', gs.diffthis, { desc = "Git: Diff current" })
          map('n', '<leader>gr', gs.reset_hunk, { desc = "Git: Reset the diff" })
          map('n', '<leader>gp', gs.preview_hunk, { desc = "Git: Preview the diff" })
        end,
      }
    end,
  })

  table.insert(plugins, {
    "folke/trouble.nvim",
    dependencies = { "nvim-tree/nvim-web-devicons" },
    opts = {
      -- your configuration comes here
      -- or leave it empty to use the default settings
      -- refer to the configuration section below
    },
  })

  table.insert(plugins, {
    "chrisgrieser/nvim-spider",
    config = function()
      require("spider").setup {
        skipInsignificantPunctuation = false,
      }
      vim.keymap.set(
        { "n", "o", "x" },
        "w",
        "<cmd>lua require('spider').motion('w')<CR>",
        { desc = "Spider-w" }
      )
      vim.keymap.set(
        { "n", "o", "x" },
        "e",
        "<cmd>lua require('spider').motion('e')<CR>",
        { desc = "Spider-e" }
      )
      vim.keymap.set(
        { "n", "o", "x" },
        "b",
        "<cmd>lua require('spider').motion('b')<CR>",
        { desc = "Spider-b" }
      )
      vim.keymap.set(
        { "n", "o", "x" },
        "ge",
        "<cmd>lua require('spider').motion('ge')<CR>",
        { desc = "Spider-ge" }
      )
    end,
  })

  table.insert(plugins, {
    "github/copilot.vim",
    config = function()
      vim.g.copilot_no_tap_map = true
      vim.g.copilot_assume_mapped = true
      vim.g.copilot_filetypes = {
        ["*"] = false,
        ["javascript"] = true,
        ["javascriptreact"] = true,
        ["typescript"] = true,
        ["typescriptreact"] = true,
        ["lua"] = true,
        ["rust"] = true,
        ["c"] = true,
        ["c++"] = true,
        ["go"] = true,
        ["python"] = true,
        ["shell"] = true,
        ["bash"] = true,
        ["zsh"] = true,
        ["sh"] = true,
        ["sql"] = true,
        ["md"] = true,
        ["json"] = true,
        ["markdown"] = true,
      }
      vim.api.nvim_set_keymap("i", "<C-L>", 'copilot#Accept("<CR>")', { silent = true, expr = true })
      vim.api.nvim_set_keymap("i", "<C-J>", 'copilot#Previous()', { silent = true, expr = true })
      vim.api.nvim_set_keymap("i", "<C-K>", 'copilot#Next()', { silent = true, expr = true })
      vim.keymap.set("i", "<C-H>", "<cmd>:Copilot<CR>", { silent = true, desc = "Copilot Panel" })
    end,
  })

  table.insert(plugins, {
    "CopilotC-Nvim/CopilotChat.nvim",
    dependencies = {
      { "github/copilot.vim" },
      { "nvim-lua/plenary.nvim", branch = "master" },
    },
    build = "make tiktoken",
    config = function()
      local chat = require("CopilotChat")
      chat.setup {
        model = 'gpt-4o',
        agent = 'copilot',
        temperature = 0.1,
        -- default window options
        window = {
          layout = 'vertical',     -- 'vertical', 'horizontal', 'float'
        },
        show_folds = true,         -- Shows folds for sections in chat
        auto_follow_cursor = true, -- Auto-follow cursor in chat
        chat_autocomplete = true,
        history_path = vim.fn.stdpath('data') .. '/copilotchat_history',
        clear_chat_on_new_prompt = false, -- Clears chat on every new prompt
        name = 'CopilotChat',             -- Name to use in chat
        separator = '---',                -- Separator to use in chat
        -- default mappings
        mappings = {
          complete = {
            detail = 'Use @<Tab> or /<Tab> for options.',
            insert = '<Tab>',
          },
          close = {
            normal = 'q',
          },
          reset = {
            normal = '<C-x>',
          },
          submit_prompt = {
            normal = '<CR>',
          },
          accept_diff = {
            normal = '<C-y>',
          },
          show_diff = {
            normal = '<C-d>',
          },
        },
        contexts = {
          git_pr_template = {
            resolve = function()
              local cmd = "cat .github/PULL_REQUEST_TEMPLATE.md"
              local pr_template = table.concat(vim.fn.systemlist(cmd), "\n")

              return {
                {
                  content = pr_template,
                  filename = "PULL_REQUEST_TEMPLATE.md",
                  filetype = "markdown",
                }
              }
            end,
          },
          git_main_diff = {
            resolve = function()
              local main_branch = vim.fn.system('git symbolic-ref --short HEAD | sed \'s/refs\\/remotes\\/origin\\///\'')
              main_branch = main_branch:gsub("^%s*(.-)%s*$", "%1")

              local cmd = 'git diff --no-ext-diff origin/' .. main_branch .. '..HEAD'
              local diff = table.concat(vim.fn.systemlist(cmd), "\n")

              return {
                {
                  content = diff,
                  filename = "main.diff",
                  filetype = "diff",
                }
              }
            end,
          },
          jira_current_task = {
            resolve = function()
              local cmd = ('echo $(git branch --show-current) | sed "s/^\\([^-]*-[^-]*\\).*/\\1/"')
              local current_task = vim.fn.system(cmd)
              current_task = current_task:gsub("^%s*(.-)%s*$", "%1")

              return {
                {
                  content = current_task,
                  filename = "jira_current_task",
                  filetype = "text",

                }
              }
            end,
          },
          git_branch = {
            resolve = function()
              local cmd = "git branch --show-current"
              local current_branch = vim.fn.system(cmd)
              current_branch = current_branch:gsub("^%s*(.-)%s*$", "%1")

              return {
                {
                  content = current_branch,
                  filename = 'git_branch',
                  filetype = 'text',
                }
              }
            end,
          },
        },
      }

      vim.api.nvim_create_user_command('CopilotChatGeneratePR',
        function()
          local cmd = {
            "Pull request template that is used in this repository:",
            "#git_pr_template",
            "Diff with the main branch:",
            "#git_main_diff",
            "Name of the current JIRA task (it can be used to replace TICKET_NUM inside the template:",
            "#jira_current_task",
            "Could you generate me a markdown file for this branch and fill the pull request template with the context I provided?",
            "You can remove the comments in the template except for the screenshots section."
          }
          chat.open()
          chat.reset()
          chat.ask(table.concat(cmd, "\n"))
        end,
        { nargs = 0 })
      vim.keymap.set('n', '<leader>aa', '<cmd>:CopilotChatOpen<CR>',
        { desc = "Copilot Chat - Open", silent = true })
      vim.keymap.set('v', '<leader>ae', '<cmd>:CopilotChatExplain<CR>',
        { desc = "Copilot Chat - Explain", silent = true })
      vim.keymap.set('v', '<leader>ar', '<cmd>:CopilotChatReview<CR>',
        { desc = "Copilot Chat - Review", silent = true })
      vim.keymap.set('v', '<leader>af', '<cmd>:CopilotChatFix<CR>', { desc = "Copilot Chat - Fix", silent = true })
      vim.keymap.set('v', '<leader>ad', '<cmd>:CopilotChatDocs<CR>', { desc = "Copilot Chat - Docs", silent = true })
      vim.keymap.set('v', '<leader>ao', '<cmd>:CopilotChatOptimize<CR>',
        { desc = "Copilot Chat - Optimize", silent = true })
      vim.keymap.set('n', '<leader>ac', '<cmd>:CopilotChatCommit<CR>', { desc = "Copilot Chat - Commit", silent = true })
      vim.keymap.set('n', '<leader>as', '<cmd>:CopilotChatCommitStaged<CR>',
        { desc = "Copilot Chat - Commit Staged", silent = true })
    end
  })

  table.insert(plugins, {
    "nvim-treesitter/nvim-treesitter-context",
    config = function()
      require('treesitter-context').setup({
        enable = true,
        max_lines = 0,
        min_window_height = 0,
        line_numbers = true,
        multiline_threshold = 20,
        trim_scope = 'outer',
        mode = 'cursor',
        separator = nil,
        zindex = 20,
        on_attach = nil,
      })
    end,
  })

  table.insert(plugins, {
    "OXY2DEV/markview.nvim",
    lazy = false,
    dependencies = {
      "nvim-treesitter/nvim-treesitter",
      "nvim-tree/nvim-web-devicons",
    },
    config = function()
    end,
  })

  table.insert(plugins, {
    "nvim-pack/nvim-spectre",
    config = function()
      require('spectre').setup({
        replace_engine = {
          ["sed"] = {
            cmd = "sed",
            args = { "-i", "", "-E" },
          },
        },
      })

      vim.keymap.set('n', '<leader>S', '<cmd>lua require("spectre").toggle()<CR>', { desc = "Toggle Spectre" })
    end,
  })
end

local function set_up_vscode_plugins(plugins)
  table.insert(plugins, {
    'nvim-treesitter/nvim-treesitter',
    dependencies = {
      'nvim-treesitter/nvim-treesitter-textobjects',
    },
    build = ":TSUpdate",
    config = function()
      require('nvim-treesitter.configs').setup({
        ensure_installed = {
          'bash',
          'markdown',
          'markdown_inline',
          'javascript',
          'typescript',
        },
        indent = { enable = true },
        incremental_selection = {
          enable = true,
          keymaps = {
            -- init_selection = "<space>", -- maps in normal mode to init the node/scope selection with space
            -- node_incremental = "<space>", -- increment to the upper named parent
            -- node_decremental = "<bs>", -- decrement to the previous node
            -- scope_incremental = "<tab>", -- increment to the upper scope (as defined in locals.scm)
          },
        },
        autopairs = {
          enable = true,
        },
        highlight = {
          enable = false,
        },
        textobjects = {
          select = {
            enable = true,
            lookahead = true, -- Automatically jump forward to textobj, similar to targets.vim
            keymaps = {
              -- You can use the capture groups defined in textobjects.scm
              ['aa'] = '@parameter.outer',
              ['ia'] = '@parameter.inner',
              ['af'] = '@function.outer',
              ['if'] = '@function.inner',
              ['ac'] = '@class.outer',
              ['ic'] = '@class.inner',
              ["iB"] = "@block.inner",
              ["aB"] = "@block.outer",
            },
          },
          move = {
            enable = true,
            set_jumps = true, -- whether to set jumps in the jumplist
            goto_next_start = {
              [']]'] = '@function.outer',
            },
            goto_next_end = {
              [']['] = '@function.outer',
            },
            goto_previous_start = {
              ['[['] = '@function.outer',
            },
            goto_previous_end = {
              ['[]'] = '@function.outer',
            },
          },
          swap = {
            enable = true,
            swap_next = {
              ['<leader>sn'] = '@parameter.inner',
            },
            swap_previous = {
              ['<leader>sp'] = '@parameter.inner',
            },
          },
        },
      })
    end,
  })
end

local function set_up_plugins()
  local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
  if not vim.loop.fs_stat(lazypath) then
    vim.fn.system({
      "git",
      "clone",
      "--filter=blob:none",
      "https://github.com/folke/lazy.nvim.git",
      "--branch=stable", -- latest stable release
      lazypath,
    })
  end

  vim.opt.rtp:prepend(lazypath)

  local user = get_user_module()

  local plugins = {}

  set_up_global_plugins(plugins)
  if user ~= nil then
    user.set_up_global_plugins(plugins)
  end

  if vim.g.vscode then
    set_up_vscode_plugins(plugins)
    if user ~= nil then
      user.set_up_vscode_plugins(plugins)
    end
  else
    set_up_nvim_only_plugins(plugins)
    if user ~= nil then
      user.set_up_nvim_only_plugins(plugins)
    end
  end

  require("lazy").setup(plugins)
end

---------------------

local function set_up_global_keybindings()
end

local function set_up_nvim_only_keybindings()
  -- shows directory
  vim.keymap.set('n', '<C-e>', ':Neotree toggle<CR>', { noremap = true, desc = "Toggle nvim-tree" })
  -- reloads the config
  vim.keymap.set('n', '<leader><CR>', ':so ~/.config/nvim/init.lua<CR>',
    { noremap = true, desc = "Re-source configuration" })

  -- MARKING
  -- Mark a file
  vim.keymap.set('n', '<leader>mm', ':lua require("harpoon.mark").add_file()<CR>',
    { noremap = true, desc = "Add current buffer to harpoon" })
  -- Unmark a file
  vim.keymap.set('n', '<leader>mu', ':lua require("harpoon.mark").rm_file()<CR>',
    { noremap = true, desc = "Remove current buffer to harpoon" })
  -- Go to next mark
  vim.keymap.set('n', '<leader>mn', ':lua require("harpoon.ui").nav_next()<CR>',
    { noremap = true, desc = "Go to next mark in the harpoon list" })
  -- Go to previous mark
  vim.keymap.set('n', '<leader>mp', ':lua require("harpoon.ui").nav_prev()<CR>',
    { noremap = true, desc = "Go to previous mark in the harpoon list" })
  -- Delete all marks
  vim.keymap.set('n', '<leader>mD', ':lua require("harpoon.mark").clear_all()<CR>',
    { noremap = true, desc = "Remove all marks from the harpoon list" })

  -- toggles the terminal
  vim.keymap.set('n', '<C-t>', ':SmartToggleTerm<CR>', { noremap = true, desc = "Toggle terminal" })
  -- toggles the trouble
  vim.keymap.set('n', '<C-j>', ':Trouble diagnostics toggle<CR>', { noremap = true, desc = "Toggle actions view" })
  -- toggle the diffview
  vim.keymap.set('n', '<C-g>', ':ToggleDiffview<CR>', { noremap = true, desc = "Toggle git overview" })

  -- REFACTORING
  -- code actions
  vim.keymap.set('n', '<leader>ra', '<Cmd>lua vim.lsp.buf.code_action()<CR>', { desc = "List code actions" })
  -- rename
  vim.keymap.set('n', '<leader>rr', '<Cmd>lua vim.lsp.buf.rename()<CR>',
    { noremap = true, desc = "Rename current word" })

  -- JUMP
  -- to definition
  vim.keymap.set('n', '<leader>jd', '<Cmd>lua vim.lsp.buf.definition()<CR>', { desc = "Jump to definition" })
  vim.keymap.set('n', '<leader>jD', '<cmd>vsplit | lua vim.lsp.buf.definition()<CR>',
    { desc = "Jump to definition in split" })
  -- to type definition
  vim.keymap.set('n', '<leader>jt', '<Cmd>lua vim.lsp.buf.type_definition()<CR>', { desc = "Jump to type definition" })
  -- to references
  vim.keymap.set('n', '<leader>jr', '<Cmd>lua vim.lsp.buf.references()<CR>', { desc = "List references" })
  -- to explorer
  vim.keymap.set('n', '<leader>je', ':Neotree reveal<CR>', { desc = "Jump to current file in nvim-tree" })
  -- quickfix - next in the list
  vim.keymap.set('n', '<leader>jn', '<Cmd>:cn<CR>', { noremap = true, desc = "Jump to next mark into quickfix" })
  -- quickfix - previous in the list
  vim.keymap.set('n', '<leader>jp', '<Cmd>:cn<CR>', { noremap = true, desc = "Jump to previous mark into quickfix" })
  -- linter warnings and errors
  vim.keymap.set('n', '<leader>jl', '<Cmd>lua vim.diagnostic.goto_next()<CR>', { desc = "Jump to next error/warning" })
  -- linter warnings and errors
  vim.keymap.set('n', '<leader>jL', '<Cmd>lua vim.diagnostic.goto_prev()<CR>',
    { desc = "Jump to previous error/warning" })

  -- PEEK/PREVIEW
  -- to docs
  vim.keymap.set('n', '<leader>pd', '<Cmd>lua vim.lsp.buf.signature_help()<CR>', { desc = "Preview symbol signature" })
  -- type definition
  vim.keymap.set('n', '<leader>ph', '<Cmd>lua vim.lsp.buf.hover()<CR>', { desc = "Preview symbol overview" })
  -- error
  vim.keymap.set('n', '<leader>pe', '<Cmd>lua vim.diagnostic.open_float()<CR>', { desc = "Preview error details" })

  -- User commands
  vim.keymap.set('n', '<leader>P', '<Cmd>:PasteInline<CR>', { noremap = true, desc = "Paste contents as inline" })

  -- User commands
  vim.keymap.set('n', '<leader>cp', '<Cmd>:CopyRelPath<CR>',
    { noremap = true, desc = "Copy relative path of current file" })

  -- Search mappings: These will make it so that going to the next one in a
  -- search will center on the line it's found in.
  vim.keymap.set('n', 'n', 'nzzzv', { noremap = true, desc = "Jump to next" })
  vim.keymap.set('n', 'N', 'Nzzzv', { noremap = true, desc = "Jump to prev" })

  -- Insert mode mappings
  vim.keymap.set('i', '<M-BS>', '<C-w>', { noremap = true, desc = "Delete previous word" })
  vim.keymap.set('c', '<M-BS>', '<C-w>', { noremap = true, desc = "Delete previous word" })
end

local function set_up_vscode_keybindings()
  vim.keymap.set('n', '<leader>g', "<Cmd>call VSCodeNotify('workbench.view.scm')<CR>")
  vim.keymap.set('n', '<leader>b', "<Cmd>call VSCodeNotify('workbench.action.toggleSidebarVisibility')<CR>")
  vim.keymap.set('n', '<leader>r', "<Cmd>call VSCodeNotify('workbench.action.openRecent')<CR>")
  -- Go to next warning/error/info
  vim.keymap.set('n', '<leader>m', "<Cmd>call VSCodeNotify('editor.action.marker.next')<CR>")
  -- Go to prev warning/error/info
  vim.keymap.set('n', '<leader>M', "<Cmd>call VSCodeNotify('editor.action.marker.prev')<CR>")
  -- Commit staged changes
  vim.keymap.set('n', '<leader>C', "<Cmd>call VSCodeNotify('git.commitStaged')<CR>")
  -- Stage changes in the file
  vim.keymap.set('n', '<leader>s', "<Cmd>call VSCodeNotify('git.stage')<CR>")
  -- Diff all changes
  vim.keymap.set('n', '<leader>D', "<Cmd>call VSCodeNotify('gitlens.externalDiffAll')<CR>")
  -- Go to next change in the file
  vim.keymap.set('n', '<leader>d', "<Cmd>call VSCodeNotify('workbench.action.editor.nextChange')<CR>")
  -- Go to previour change in the file
  -- vim.keymap.set('n', '<leader>f', "<Cmd>call VSCodeNotify('workbench.action.editor.previousChange')<CR>")
  -- Search in files
  vim.keymap.set('n', '<leader>ff', "<Cmd>call VSCodeNotify('search.action.openNewEditorToSide')<CR>")
  -- Focuses on the search results
  vim.keymap.set('n', '<leader>fn', "<Cmd>call VSCodeNotify('search.action.focusNextSearchResult')<CR>")
  -- Focuses on the search input
  vim.keymap.set('n', '<leader>fi', "<Cmd>call VSCodeNotify('search.action.focusQueryEditorWidget')<CR>")
  -- Focuses on the include input
  vim.keymap.set('n', '<leader>fc', "<Cmd>call VSCodeNotify('search.action.focusFilesToInclude')<CR>")
  -- Focuses on the exclude input
  vim.keymap.set('n', '<leader>fe', "<Cmd>call VSCodeNotify('search.action.focusFilesToExclude')<CR>")
end

local function set_up_keybindings()
  local user = get_user_module()

  set_up_global_keybindings()
  if user ~= nil then
    user.set_up_global_keybindings()
  end
  if vim.g.vscode then
    set_up_vscode_keybindings()
    if user ~= nil then
      user.set_up_vscode_keybindings()
    end
  else
    set_up_nvim_only_keybindings()
    if user ~= nil then
      user.set_up_nvim_only_keybindings()
    end
  end
end

---------------------

set_up_config()
set_up_plugins()
set_up_keybindings()
