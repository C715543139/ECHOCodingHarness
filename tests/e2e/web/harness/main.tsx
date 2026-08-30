import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '../../../../src/web/client/App.js';
import '../../../../src/web/client/styles/global.css';
import type { FakeTransport } from '../../../../src/web/client/transport/fake-transport.js';
import {
  createWebScenarioTransport,
  isWebScenarioName,
} from '../../../web-fixtures/fake-provider-web-scenarios.js';

declare global {
  interface Window {
    __echoTransport?: FakeTransport;
  }
}

const params = new URLSearchParams(window.location.search);
const requested = params.get('scenario') ?? 'empty';
const scenario = isWebScenarioName(requested) ? requested : 'empty';
const transport = createWebScenarioTransport(scenario);
window.__echoTransport = transport;

const rootElement = document.querySelector('#root');
if (rootElement === null) {
  throw new Error('ECHO Web e2e root element is missing.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App transport={transport} />
  </StrictMode>,
);
