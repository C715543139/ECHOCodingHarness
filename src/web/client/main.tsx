import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './styles/global.css';
import { createHttpTransport } from './transport/http-transport.js';

const rootElement = document.querySelector('#root');

if (rootElement === null) {
  throw new Error('ECHO Web root element is missing.');
}

const transport = createHttpTransport();
window.addEventListener('pagehide', () => {
  transport.dispose();
});

createRoot(rootElement).render(
  <StrictMode>
    <App transport={transport} />
  </StrictMode>,
);
