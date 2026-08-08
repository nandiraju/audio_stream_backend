import { useCallback, useRef, useState } from 'react';

// Promise-based confirm dialog: call confirm({...}) and await a boolean.
export function useConfirm() {
  const [opts, setOpts] = useState(null);
  const resolveRef = useRef(null);

  const confirm = useCallback((options) => {
    setOpts(options);
    return new Promise((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const close = useCallback((result) => {
    setOpts(null);
    if (resolveRef.current) {
      resolveRef.current(result);
      resolveRef.current = null;
    }
  }, []);

  const modal = opts ? (
    <div className="modal-backdrop" onClick={() => close(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{opts.title}</h3>
        {opts.message && <p>{opts.message}</p>}
        <div className="modal-actions">
          {opts.showCancel && (
            <button className="ctl" onClick={() => close(false)}>Cancel</button>
          )}
          <button className={'ctl' + (opts.danger ? ' danger' : '')} autoFocus onClick={() => close(true)}>
            {opts.okLabel || 'OK'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return [modal, confirm];
}
