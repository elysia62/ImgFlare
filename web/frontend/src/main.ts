/** Start the controller selected by the HTML page. */

import { initApp } from './app.js';
import { initLoginPage } from './auth.js';
import { initTheme } from './theme.js';

async function boot(): Promise<void> {
  initTheme();

  const page = document.body.dataset.page;

  if (page === 'login') {
    await initLoginPage();
    return;
  }

  if (page === 'panel') {
    await initApp();
    return;
  }

}

void boot().catch((error: unknown) => {
  // Nothing else can report a boot failure, so surface it directly.
  console.error('failed to start', error);
  const message = error instanceof Error ? error.message : String(error);
  document.body.textContent = `页面初始化失败：${message}`;
});
