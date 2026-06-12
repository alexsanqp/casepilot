import { useState } from 'react';
import { Modal } from './Modal';

export function ExportModal({
  name,
  specTs,
  onClose,
}: {
  name: string;
  specTs: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(specTs);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Modal title={`Export: ${name}`} onClose={onClose}>
      <pre className="code-block">{specTs}</pre>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </Modal>
  );
}
