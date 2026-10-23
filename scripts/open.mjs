import { ensureDaemon, dashboardUrl, requestApi } from '../src/daemon-client.mjs';
import { launchBrowser, parseOpenArgs } from '../src/launcher.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function openManager({ ensure = ensureDaemon, launch = launchBrowser, reconnect = () => requestApi('/api/desktop/reconnect', { method: 'POST', body: {}, timeoutMs: 15000 }), print = console.log, urlOnly = false } = {}) {
  const endpoint = await ensure();
  // A stale desktop channel must not make the management page inaccessible.
  // The page reads the real status and can offer another connection attempt.
  let connection;
  try { connection = await reconnect(endpoint); }
  catch (error) { connection = { desktop: { connected: false, message: error.message } }; }
  const url = dashboardUrl(endpoint);
  if (urlOnly) print(url);
  else await launch(url);
  return { opened: !urlOnly, endpoint, connection };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => openManager(parseOpenArgs(process.argv.slice(2)))).catch(error => {
    console.error(`管理器未能打开：${error.message}`);
    process.exitCode = 1;
  });
}
