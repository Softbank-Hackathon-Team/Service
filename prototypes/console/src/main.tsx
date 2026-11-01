import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design/fonts/pretendard-jp/pretendardvariable-jp-dynamic-subset.css';
import './design/tokens.css';
import './design/base.css';
import { App } from './app/App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
