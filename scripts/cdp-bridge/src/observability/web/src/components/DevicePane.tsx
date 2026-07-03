import type { JSX } from 'react';

interface DevicePaneProps {
  liveShotSeq: number | null;
  /** seq of the latest device_screenshot event, used before any live frame exists. */
  fallbackSeq: number | null;
  route: string | null;
}

export function DevicePane({ liveShotSeq, fallbackSeq, route }: DevicePaneProps): JSX.Element {
  const src =
    liveShotSeq != null
      ? `/api/live-screenshot/${liveShotSeq}`
      : fallbackSeq != null
        ? `/api/screenshot/${fallbackSeq}`
        : null;
  return (
    <div className="pane center">
      <div className="pane-head">
        Device
        {route && <span className="route-chip">{route}</span>}
      </div>
      <div className="screen">
        {src ? (
          <div className="device-frame">
            <img src={src} alt="device screenshot" />
          </div>
        ) : (
          <div className="empty empty-guide">
            <div className="empty-title">No screenshot yet</div>
            <div>
              The screen appears here automatically after the agent interacts with the app.
            </div>
            <div>Nothing showing? Check the connection with cdp_status.</div>
          </div>
        )}
      </div>
    </div>
  );
}
