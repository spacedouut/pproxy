// Slash command logic, kept free of discord.js so it can be tested with a fake interaction.
// Talks to pproxy only through /manage/v1 with the master key.

const EPHEMERAL = 64;
const MANAGE_GUILD = '32';
const NO_MENTIONS = { parse: [] };

export const DEFINITIONS = [
    {
        name: 'add',
        description: 'Add a Puter account to pproxy',
        default_member_permissions: MANAGE_GUILD,
        contexts: [0],
        options: [{
            type: 3,
            name: 'token',
            description: 'Puter token (leave empty to get a sign-in link)',
            required: false,
        }],
    },
    {
        name: 'accounts',
        description: 'List pproxy accounts and their credit',
        default_member_permissions: MANAGE_GUILD,
        contexts: [0],
    },
];

const credit = (v, unit) => v == null ? '?' : unit === 'microcents' ? `$${(v / 1e8).toFixed(2)}` : `${v > 0 && v < 1 ? v.toPrecision(2) : Math.round(v * 10) / 10}`;

export function describeAccount (a) {
    const u = a.usage;
    const left = u ? `${credit(u.remaining, u.unit)} of ${credit(u.allowance, u.unit)}${u.unit && u.unit !== 'microcents' ? ` ${u.unit}` : ''} left` : 'usage unknown';
    const flags = [!a.enabled && 'disabled', a.status && a.status !== 'ok' && a.status].filter(Boolean).join(', ');
    return `**${a.username}** \`${a.id}\` ${left}${flags ? ` [${flags}]` : ''}`;
}

export function createCommands ({ pproxyUrl, masterKey, publicUrl, allowedUsers = [], pollMs = 3000, timeoutMs = 14 * 60 * 1000 }) {
    const base = pproxyUrl.replace(/\/$/, '');

    async function manage (method, path, body) {
        const r = await fetch(`${base}/manage/v1${path}`, {
            method,
            headers: { authorization: `Bearer ${masterKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const j = await r.json().catch(() => ({}));
        if (j.error && !j.request_id) throw new Error(j.error.message ?? `pproxy returned ${r.status}`);
        return j;
    }

    const failed = (rec) => `Could not add account: ${rec.error?.message ?? 'unknown error'}`;
    const added = (a) => `Added ${describeAccount(a)}`;

    async function add (interaction) {
        const token = interaction.options.getString('token')?.trim();
        if (token) {
            const rec = await manage('POST', '/add-account', { token });
            return interaction.editReply(rec.status === 'succeeded' ? added(rec.result) : failed(rec));
        }

        const rec = await manage('POST', '/add-account', publicUrl ? { base: publicUrl } : {});
        if (rec.status === 'failed') return interaction.editReply(failed(rec));
        const url = rec.result?.url;
        await interaction.editReply({
            content: 'Sign in to Puter with the account you want to add. This message updates when it is done.\n'
                + 'If the page you land on afterwards does not load, copy the `token=` value from its address and run `/add token:<token>`.',
            components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Sign in to Puter', url }] }],
        });

        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            await new Promise(r => setTimeout(r, pollMs));
            const cur = await manage('GET', `/request/${rec.request_id}`).catch(() => null);
            if (!cur) continue;
            if (cur.status === 'succeeded') return interaction.editReply({ content: added(cur.result), components: [] });
            if (cur.status === 'failed') return interaction.editReply({ content: failed(cur), components: [] });
        }
        return interaction.editReply({ content: 'Timed out waiting for sign-in. Run `/add` again.', components: [] });
    }

    async function accounts (interaction) {
        const { data = [] } = await manage('GET', '/accounts');
        if (!data.length) return interaction.editReply('No accounts yet. Add one with `/add`.');
        const lines = [];
        let len = 0;
        for (const a of data) {
            const line = describeAccount(a);
            if (len + line.length > 1900) break;
            lines.push(line);
            len += line.length + 1;
        }
        if (lines.length < data.length) lines.push(`...and ${data.length - lines.length} more`);
        return interaction.editReply(lines.join('\n'));
    }

    const handlers = { add, accounts };

    async function handle (raw) {
        const run = handlers[raw.commandName];
        if (!run) return;
        const quiet = (o) => ({ ...(typeof o === 'string' ? { content: o } : o), allowedMentions: NO_MENTIONS });
        const interaction = {
            user: raw.user,
            options: raw.options,
            deferReply: (o) => raw.deferReply(o),
            reply: (o) => raw.reply(quiet(o)),
            editReply: (o) => raw.editReply(quiet(o)),
        };
        if (allowedUsers.length && !allowedUsers.includes(interaction.user.id)) {
            return interaction.reply({ content: 'You are not allowed to manage this pproxy.', flags: EPHEMERAL });
        }
        await interaction.deferReply({ flags: EPHEMERAL });
        try {
            await run(interaction);
        } catch (e) {
            await interaction.editReply({ content: `pproxy error: ${e.message}`, components: [] }).catch(() => {});
        }
    }

    return { handle };
}
