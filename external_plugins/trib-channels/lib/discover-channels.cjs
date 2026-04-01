/**
 * Temporary Discord bot connection to discover channels.
 * Used by the setup skill before config.json exists.
 *
 * Usage:
 *   node discover-channels.js discord <bot-token>    — list guild text channels
 *
 * Output: JSON on stdout
 *   Discord: [{ name, id }]
 */

const backend = process.argv[2]
const token = process.argv[3]

if (!backend || !token) {
  console.error('usage: node discover-channels.js discord <token>')
  process.exit(1)
}

setTimeout(() => { console.error('connection timeout'); process.exit(1) }, 15000)

if (backend === 'discord') {
  const { Client, GatewayIntentBits } = require('discord.js')
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
  client.login(token)

} else {
  console.error(`Unknown backend: ${backend}. Use "discord".`)
  process.exit(1)
}
