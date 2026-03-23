/**
 * Temporary Discord connection to discover guild channels.
 * Used by the setup skill before config.json exists.
 *
 * Usage: node discover-channels.js <bot-token>
 * Output: JSON array of { name, id } on stdout
 */
const { Client, GatewayIntentBits } = require('discord.js')

const token = process.argv[2]
if (!token) { console.error('usage: node discover-channels.js <token>'); process.exit(1) }

const client = new Client({ intents: [GatewayIntentBits.Guilds] })

client.once('ready', () => {
  const channels = []
  client.guilds.cache.forEach(g => {
    g.channels.cache
      .filter(ch => ch.type === 0) // text channels
      .forEach(ch => channels.push({ name: '#' + ch.name, id: ch.id }))
  })
  console.log(JSON.stringify(channels, null, 2))
  client.destroy()
  process.exit(0)
})

client.on('error', err => { console.error(err.message); process.exit(1) })
setTimeout(() => { console.error('connection timeout'); process.exit(1) }, 15000)
client.login(token)
