/**
 * Login page logic: password + Turnstile, server-verified.
 *
 * The Turnstile widget's response token is posted to the server, which performs
 * the real check against `siteverify`. The widget on its own proves nothing.
 */

import { ApiError, login, me } from './api.js';
import { humanizeError } from './types.js';
import { byId } from './ui.js';

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
      theme?: 'auto' | 'light' | 'dark';
    },
  ): string;
  reset(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export async function initLoginPage(): Promise<void> {
  // Already signed in? Skip the form entirely.
  try {
    const who = await me();
    if (who.authenticated) {
      window.location.replace('/');
      return;
    }
  } catch {
    // Not signed in, or the check failed — show the form either way.
  }

  const form = byId<HTMLFormElement>('login-form');
  const usernameInput = byId<HTMLInputElement>('username');
  const passwordInput = byId<HTMLInputElement>('password');
  const submitButton = byId<HTMLButtonElement>('login-submit');
  const errorBox = byId('login-error');
  const turnstileHost = byId('turnstile');

  const siteKey = document.body.dataset.turnstileSiteKey ?? '';
  let turnstileToken = '';
  let widgetId: string | undefined;

  turnstileHost.hidden = false;
  mountTurnstile();

  function mountTurnstile(): void {
    const attempt = (tries: number): void => {
      if (window.turnstile) {
        widgetId = window.turnstile.render(turnstileHost, {
          sitekey: siteKey,
          theme: 'auto',
          callback: (token) => {
            turnstileToken = token;
            clearError();
            // Solved — collapse the widget so it stops reserving space. The
            // token stays in memory; the widget is only re-shown if the server
            // rejects it and a fresh one is needed.
            hideTurnstile();
          },
          'expired-callback': () => {
            turnstileToken = '';
            showTurnstile();
          },
          'error-callback': () => {
            turnstileToken = '';
            showError('人机验证加载失败，请刷新页面');
          },
        });
        return;
      }
      if (tries <= 0) {
        showError('人机验证加载失败，请检查网络后刷新');
        return;
      }
      window.setTimeout(() => attempt(tries - 1), 200);
    };
    attempt(25); // ~5 seconds of patience
  }

  function hideTurnstile(): void {
    turnstileHost.hidden = true;
  }

  function showTurnstile(): void {
    turnstileHost.hidden = false;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });

  async function submit(): Promise<void> {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username) {
      showError('请输入用户名');
      usernameInput.focus();
      return;
    }
    if (!password) {
      showError('请输入密码');
      passwordInput.focus();
      return;
    }
    if (!turnstileToken) {
      showError('请先完成人机验证');
      return;
    }

    setBusy(true);
    clearError();

    try {
      await login(username, password, turnstileToken);
      window.location.replace('/');
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'too_many_attempts') {
          showError('尝试次数过多，请 15 分钟后再试');
        } else if (
          error.code === 'turnstile_failed' ||
          error.code === 'turnstile_missing'
        ) {
          showError(humanizeError(error.code));
        } else {
          showError('用户名或密码不正确');
        }
      } else {
        showError('登录失败，请重试');
      }

      // The Turnstile token is single-use; get a fresh one for the next try.
      turnstileToken = '';
      if (widgetId && window.turnstile) {
        window.turnstile.reset(widgetId);
        showTurnstile();
      }
      passwordInput.select();
    } finally {
      setBusy(false);
    }
  }

  function setBusy(busy: boolean): void {
    submitButton.disabled = busy;
    submitButton.textContent = busy ? '登录中…' : '登录';
  }

  function showError(message: string): void {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function clearError(): void {
    errorBox.textContent = '';
    errorBox.hidden = true;
  }

  usernameInput.focus();
}
