// Operator commands. Run with: node --env-file=.env src/cli.mjs <command>
//   bot <owner> [ENV_VAR]                                  new bot to link (ENV_VAR imports an existing bot key); prints its secret once
//   start <bot> <hours> <usdso> [trader|-] [max loss usdso]  start a shift: follow `trader`, or `-` for the preset strategy
//   stop <id>                                              end a shift now; the worker brings it to flat
//   list | show <id>
import * as store from './store.mjs';

const [cmd, a, b, c, d, e] = process.argv.slice(2);
const json = (v) => console.log(JSON.stringify(v, null, 2));
if (cmd === 'bot') json(store.newBot(a, b ? process.env[b] : undefined));
else if (cmd === 'start') console.log(`shift ${store.startSession({ bot: a, hours: Number(b), notional: c, trader: d && d !== '-' ? d : null, maxLoss: e ?? null })}`);
else if (cmd === 'stop') store.stopNow(Number(a), 'Ended early by the owner.');
else if (cmd === 'list') json(store.sessions());
else if (cmd === 'show') json({ session: store.session(Number(a)), events: store.events(Number(a)) });
else console.log('commands: bot, start, stop, list, show');
