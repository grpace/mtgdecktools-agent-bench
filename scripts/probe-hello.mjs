import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:9374/ws');
ws.on('message', (d) => { console.log(String(d).slice(0, 1500)); ws.close(); });
ws.on('error', (e) => console.error('err', e.message));
setTimeout(() => process.exit(0), 4000);
