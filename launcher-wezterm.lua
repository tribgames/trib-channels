local wezterm = require 'wezterm'

local config = {}
local socket_path = os.getenv 'CLAUDE2BOT_WEZTERM_SOCKET'

config.unix_domains = {
  {
    name = 'unix',
    socket_path = socket_path,
  },
}

return config
