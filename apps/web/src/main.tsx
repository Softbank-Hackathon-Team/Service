import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design/fonts.css';
import './design/tokens.css';
import './design/base.css';
import { App } from './app/App';

if (import.meta.env.DEV) void import('./dev-layout-check');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
