import { startObserveServer } from './dist/tools/observe.js';

const res = await startObserveServer();
console.log('OBSERVE_URL', res.url);
setInterval(() => {}, 1_000_000);
