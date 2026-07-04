import { useEffect, useState, type JSX } from 'react';
import type { MirrorState } from '../types';

interface DevicePaneProps {
  mirror: MirrorState | null;
  liveShotSeq: number | null;
  /** seq of the latest device_screenshot event, used before any live frame exists. */
  fallbackSeq: number | null;
  route: string | null;
}

const MAX_MIRROR_RETRIES = 3;

export function DevicePane({
  mirror,
  liveShotSeq,
  fallbackSeq,
  route,
}: DevicePaneProps): JSX.Element {
  // Nonce busts the browser's connection cache on retry; attempts cap avoids
  // hammering a dead endpoint (mirror disabled / persistent capture error).
  const [nonce, setNonce] = useState(1);
  const [attempts, setAttempts] = useState(0);

  // A fresh starting/streaming status is the server telling us the pipeline is
  // (re)alive — re-arm the <img> retry budget.
  useEffect(() => {
    if (mirror?.status === 'starting' || mirror?.status === 'streaming') {
      setAttempts(0);
      setNonce((n) => n + 1);
    }
  }, [mirror?.status]);

  const mirrorBroken = mirror?.status === 'error' || attempts >= MAX_MIRROR_RETRIES;
  const useMirror = !mirrorBroken;

  const fallbackSrc =
    liveShotSeq != null
      ? `/api/live-screenshot/${liveShotSeq}`
      : fallbackSeq != null
        ? `/api/screenshot/${fallbackSeq}`
        : null;

  const onMirrorError = (): void => {
    // mirror === null means no {type:'mirror'} SSE status has ever arrived —
    // the endpoint is almost certainly disabled/absent (404) or the backend
    // predates mirror support, and nothing will ever push a status to re-arm
    // the retry budget. Retrying a permanent 404 only delays the fallback
    // screenshot, so skip straight to the fallback instead of burning the
    // retry timers.
    if (mirror === null) {
      setAttempts(MAX_MIRROR_RETRIES);
      return;
    }
    setAttempts((a) => a + 1);
    if (attempts + 1 < MAX_MIRROR_RETRIES) {
      setTimeout(() => setNonce((n) => n + 1), 2000);
    }
  };

  const statusLine =
    mirror?.status === 'streaming'
      ? `mirror: ${mirror.pipeline}${mirror.fps ? ` ~${mirror.fps}fps` : ''}`
      : mirror?.status === 'error'
        ? `mirror off: ${mirror.reason ?? 'error'}`
        : null;

  return (
    <div className="pane center">
      <div className="pane-head">
        Device
        {route && <span className="route-chip">{route}</span>}
      </div>
      <div className="screen">
        {useMirror ? (
          <div className="device-frame">
            <img
              src={`/api/device/mirror?t=${nonce}`}
              alt="live device mirror"
              onError={onMirrorError}
            />
          </div>
        ) : fallbackSrc ? (
          <div className="device-frame">
            <img src={fallbackSrc} alt="device screenshot" />
          </div>
        ) : (
          <div className="empty empty-guide">
            <div className="empty-title">No screenshot yet</div>
            <div>The screen appears here automatically after the agent interacts with the app.</div>
            <div>Nothing showing? Check the connection with cdp_status.</div>
          </div>
        )}
        {(statusLine || mirror?.hint) && (
          <div className="mirror-status">
            {statusLine}
            {mirror?.hint ? <span className="mirror-hint"> — {mirror.hint}</span> : null}
          </div>
        )}
      </div>
    </div>
  );
}
