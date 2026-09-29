import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { detectSupport, unsupportedReason } from '../support';
import { ReceiveTab } from './ReceiveTab';
import { ShareTab } from './ShareTab';
import { readTokenFromFragment } from './shareLink';
import './styles.css';

export type TabId = 'share' | 'receive';

export function App({ children }: { children?: ReactNode }) {
  const [tab, setTab] = useState<TabId>(() =>
    readTokenFromFragment(window.location.href) === '' ? 'share' : 'receive',
  );
  const blocked = unsupportedReason(detectSupport());

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setTab((current) => (current === 'share' ? 'receive' : 'share'));
  };

  return (
    <main className="app">
      <h1>p2pfilesharing</h1>
      {blocked !== null && (
        <p className="error" role="alert">
          {blocked}
        </p>
      )}
      <div className="tabs" role="tablist" onKeyDown={onKeyDown}>
        <button
          type="button"
          role="tab"
          id="tab-share"
          aria-controls="panel"
          aria-selected={tab === 'share'}
          tabIndex={tab === 'share' ? 0 : -1}
          className="tab"
          disabled={blocked !== null}
          onClick={() => setTab('share')}
        >
          Sharing
        </button>
        <button
          type="button"
          role="tab"
          id="tab-receive"
          aria-controls="panel"
          aria-selected={tab === 'receive'}
          tabIndex={tab === 'receive' ? 0 : -1}
          className="tab"
          disabled={blocked !== null}
          onClick={() => setTab('receive')}
        >
          Receiving
        </button>
      </div>
      <div role="tabpanel" id="panel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {children ?? (tab === 'share' ? <ShareTab /> : <ReceiveTab />)}
      </div>
    </main>
  );
}
