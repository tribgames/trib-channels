local wezterm = require 'wezterm'

local config = {}
local socket_path = os.getenv 'CLAUDE2BOT_WEZTERM_SOCKET'

config.unix_domains = {
  {
    name = 'unix',
    socket_path = socket_path,
    connect_automatically = true,
  },
}

-- Suppress any startup dialogs
config.check_for_updates = false
config.show_update_window = false

return config
