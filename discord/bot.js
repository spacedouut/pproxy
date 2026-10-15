#!/usr/bin/env node
import { Client, Events, GatewayIntentBits, REST, Routes } from 'discord.js';
import { DEFINITIONS, createCommands } from './commands.js';

const env = process.env;
for (const k of ['DISCORD_TOKEN', 'PPROXY_MASTER_KEY']) {
    if (!env[k]) {
        console.error(`${k} is required`);
        process.exit(1);
    }
}

const commands = createCommands({
    pproxyUrl: env.PPROXY_URL || 'http://127.0.0.1:9032',
    masterKey: env.PPROXY_MASTER_KEY,
    publicUrl: env.PPROXY_PUBLIC_URL,
    allowedUsers: (env.DISCORD_ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean),
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
    const rest = new REST().setToken(env.DISCORD_TOKEN);
    const route = env.DISCORD_GUILD_ID
        ? Routes.applicationGuildCommands(c.application.id, env.DISCORD_GUILD_ID)
        : Routes.applicationCommands(c.application.id);
    await rest.put(route, { body: DEFINITIONS });
    console.log(`logged in as ${c.user.tag}, registered /add and /accounts${env.DISCORD_GUILD_ID ? ` in guild ${env.DISCORD_GUILD_ID}` : ' globally'}`);
});

client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand()) commands.handle(interaction).catch(e => console.error(e));
});

client.login(env.DISCORD_TOKEN);
