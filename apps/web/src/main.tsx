import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design/fonts.css';
import './design/tokens.css';
import './design/base.css';
import { App } from './app/App';
import { startNav } from './app/nav';
import { PRODUCT_NAME } from './components/ui/Logo';
import { locale, t } from './lib/i18n';
import { applyTheme, readActivePrefs } from './lib/prefs';

// 이 브라우저에서 마지막으로 고른 테마·언어로 그린다. 로그인하면 그 사람의 설정으로 맞춘다 (App)
applyTheme(readActivePrefs().theme);
document.documentElement.lang = locale();
document.title = t('{0} 콘솔', { 0: PRODUCT_NAME });
startNav();

if (import.meta.env.DEV) void import('./dev-layout-check');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
