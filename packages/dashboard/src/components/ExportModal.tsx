import { useState } from 'react';
import { Modal } from './Modal';

type CopyState = 'idle' | 'copied' | 'failed';

function copyViaExecCommand(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

export function ExportModal({
  name,
  specTs,
  onClose,
}: {
  name: string;
  specTs: string;
  onClose: () => void;
}) {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  // The state intentionally never reverts while the modal is open: short-lived
  // feedback is invisible to both screen-reader users and recording agents.
  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(specTs);
      ok = true;
    } catch {
      ok = copyViaExecCommand(specTs);
    }
    setCopyState(ok ? 'copied' : 'failed');
  };

  return (
    <Modal title={`Export: ${name}`} onClose={onClose}>
      <pre className="code-block">{specTs}</pre>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={() => void copy()}>
          {copyState === 'copied' ? 'Copied' : 'Copy'}
        </button>
        {copyState === 'failed' && (
          <span className="message message-error">Copy failed — select the code manually.</span>
        )}
      </div>
    </Modal>
  );
}
