// Debug helper: show a seat's current decision, optionally answer it. Usage: node scripts/peek-seat.mjs <seat-url> [option]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const c = new Client({ name: 'peek', version: '0' });
await c.connect(new StreamableHTTPClientTransport(new URL(process.argv[2])));
const t = (await c.callTool({ name: 'wait_for_decision', arguments: {} })).content[0].text;
console.log(t.slice(0, 3000));
const m = t.match(/DECISION (\S+) —/);
if (m && process.argv[3]) {
  const r = await c.callTool({ name: 'decide', arguments: { decision_id: m[1], option: process.argv[3], note: 'peek' } });
  console.log('\n=== decide ===\n' + r.content[0].text.slice(0, 800));
}
await c.close();
