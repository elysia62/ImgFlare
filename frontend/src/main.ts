/**
 * Entry point.
 *
 * Both pages load the same bundle; this decides which controller to start based
 * on a marker attribute on `<body>`. That keeps the build to a single file while
 * still letting each page pull in only the code it needs at runtime.
 */

import { initApp } from './app.js';
import { initLoginPage } from './auth.js';

async function boot(): Promise<void> {
  const page = document.body.dataset.page;

  if (page === 'login') {
    await initLoginPage();
    return;
  }

  if (page === 'panel') {
    await initApp();
    return;
  }

  // Fallback for a page that forgot to declare itself: pick by the presence of
  // the login form, which is a reliable signal.
  if (document.getElementById('login-form')) {
    await initLoginPage();
  } else {
    await initApp();
  }
}

void boot().catch((error: unknown) => {
  // Nothing else can report a boot failure, so surface it directly.
  console.error('failed to start', error);
  const message = error instanceof Error ? error.message : String(error);
  document.body.textContent = `页面初始化失败：${message}`;
});
