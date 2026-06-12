import { useEffect, useState } from 'react';
import { errorMessage, listDirs } from '../api/client';
import type { FsDirsResponse } from '../api/types';
import { Modal } from './Modal';

export function DirectoryPicker({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<FsDirsResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const navigate = (path?: string) => {
    setBusy(true);
    setError(null);
    setSelected(null);
    listDirs(path)
      .then(setListing)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    navigate();
  }, []);

  const current = listing?.path ?? '';
  const choice = selected ?? (current || null);

  return (
    <Modal title="Select directory" onClose={onClose}>
      <div className="dir-picker">
        <div className="dir-picker-crumbs">
          <button
            type="button"
            className="btn"
            disabled={busy || !listing || listing.parent === null}
            onClick={() => listing && navigate(listing.parent ?? undefined)}
          >
            ↑ Up
          </button>
          <code className="dir-picker-path" title={current}>
            {current || 'Drives'}
          </code>
        </div>
        {error && <p className="message message-error">{error}</p>}
        {!listing && !error && <p className="muted">Loading…</p>}
        {listing && (
          <ul className="dir-picker-list">
            {listing.dirs.length === 0 && <li className="muted">No subdirectories.</li>}
            {listing.dirs.map((dir) => (
              <li key={dir.path}>
                <button
                  type="button"
                  className={`dir-picker-item ${selected === dir.path ? 'dir-picker-item-selected' : ''}`}
                  disabled={busy}
                  onClick={() => setSelected(dir.path)}
                  onDoubleClick={() => navigate(dir.path)}
                >
                  {dir.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || choice === null}
            onClick={() => {
              if (choice !== null) {
                onSelect(choice);
                onClose();
              }
            }}
          >
            Select{selected ? '' : ' current'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
