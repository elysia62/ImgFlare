/** Persist an explicit light/dark preference; otherwise follow the system. */

const THEME_KEY = 'pih_theme';

type Theme = 'light' | 'dark';

/** The theme currently in effect, resolving "no preference" via the OS. */
function activeTheme(): Theme {
  const pinned = document.documentElement.dataset.theme;
  if (pinned === 'light' || pinned === 'dark') return pinned;

  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private mode: the theme still applies for this page load.
  }
  updateButtons(theme);
}

function updateButtons(theme: Theme): void {
  for (const button of document.querySelectorAll<HTMLElement>('#theme-toggle')) {
    button.dataset.theme = theme;
    button.title = theme === 'dark' ? '切换到浅色' : '切换到深色';
  }
}

/** Restore the stored choice before first paint. */
export function initTheme(): void {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(THEME_KEY);
  } catch {
    stored = null;
  }

  if (stored === 'light' || stored === 'dark') {
    document.documentElement.dataset.theme = stored;
  }

  updateButtons(activeTheme());

  for (const button of document.querySelectorAll<HTMLElement>('#theme-toggle')) {
    button.addEventListener('click', () => {
      apply(activeTheme() === 'dark' ? 'light' : 'dark');
    });
  }
}
