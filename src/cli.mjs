// Operator commands until the web page exists. Run with: node --env-file=.env src/cli.mjs <command>
//   bot <owner> [ENV_VAR]          bot address to link (ENV_VAR imports an existing bot key)
//   start <owner> <hours> <usdso>  start a session with that notional cap
//   stop <id>                      end a session now; the worker brings it to flat
//   list | show <id>
import * as store from './store.mjs';

const [cmd, a, b, c] = process.argv.slice(2);
const json = (v) => console.log(JSON.stringify(v, null, 2));
if (cmd === 'bot') console.log(store.botFor(a, b ? process.env[b] : undefined));
else if (cmd === 'start') console.log(`session ${store.startSession({ owner: a, hours: Number(b), notional: c })}`);
else if (cmd === 'stop') store.stopNow(Number(a));
else if (cmd === 'list') json(store.sessions());
else if (cmd === 'show') json({ session: store.session(Number(a)), events: store.events(Number(a)) });
else console.log('commands: bot, start, stop, list, show');
