import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design/fonts.css';
import './design/tokens.css';
import './design/base.css';
import { App } from './app/App';

// 개발용 목업. 파일을 지우면 빈 결과가 되어 아무 일도 하지 않는다.
import.meta.glob('./dev-mock.ts', { eager: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
