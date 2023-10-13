local wezterm = require 'wezterm'

local config = wezterm.config_builder()
config.font = wezterm.font 'JetBrainsMono Nerd Font'
config.font_size = 14.0
config.automatically_reload_config = false
config.window_decorations = "RESIZE"
config.enable_tab_bar = false
config.default_prog = { '/opt/homebrew/bin/tmux', 'new-session', '-A', '-D', '-s', 'main' }
config.disable_default_key_bindings = true

wezterm.on('gui-attached', function()
  local mux = wezterm.mux
  -- maximize all displayed windows on startup
  local workspace = mux.get_active_workspace()
  for _, window in ipairs(mux.all_windows()) do
    if window:get_workspace() == workspace then
      window:gui_window():maximize()
    end
  end
end)

return config
