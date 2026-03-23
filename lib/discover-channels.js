/**
 * Temporary bot connection to discover channels or verify token.
 * Used by the setup skill before config.json exists.
 *
 * Usage:
 *   node discover-channels.js discord <bot-token>    — list guild text channels
 *   node discover-channels.js telegram <bot-token>   — verify token via getMe
 *
 * Output: JSON on stdout
 *   Discord:  [{ name, id }]
 *   Telegram: { ok, username, firstName, id }
 */

const backend = process.argv[2]
const token = process.argv[3]

if (!backend || !token) {
  console.error('usage: node discover-channels.js <discord|telegram> <token>')
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

} else if (backend === 'telegram') {
  const https = require('https')

  const url = `https://api.telegram.org/bot${token}/getMe`
  https.get(url, res => {
    let data = ''
    res.on('data', chunk => { data += chunk })
    res.on('end', () => {
      try {
        const body = JSON.parse(data)
        if (body.ok) {
          console.log(JSON.stringify({
            ok: true,
            username: body.result.username,
            firstName: body.result.first_name,
            id: body.result.id,
          }, null, 2))
          process.exit(0)
        } else {
          console.error(`Telegram API error: ${body.description}`)
          process.exit(1)
        }
      } catch (e) {
        console.error(`Failed to parse response: ${e.message}`)
        process.exit(1)
      }
    })
  }).on('error', err => {
    console.error(`Connection error: ${err.message}`)
    process.exit(1)
  })

} else {
  console.error(`Unknown backend: ${backend}. Use "discord" or "telegram".`)
  process.exit(1)
}
