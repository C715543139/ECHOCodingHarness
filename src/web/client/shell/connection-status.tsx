import type { ConnectionState } from '../transport/fake-transport.js';
import styles from './shell.module.css';

export function ConnectionStatus({ state }: { readonly state: ConnectionState }) {
  const connected = state === 'connected';
  const label = connected ? '已连接' : '未连接';

  return (
    <p className={styles.status} data-testid="connection-status" role="status">
      <span
        aria-hidden="true"
        className={`${styles.dot} ${connected ? styles.dotConnected : styles.dotDisconnected}`}
        data-testid={connected ? 'connection-dot-connected' : 'connection-dot-disconnected'}
      />
      <span>{label}</span>
      {state === 'reconnecting' ? <span className={styles.reconnectHint}>正在重连</span> : null}
    </p>
  );
}
