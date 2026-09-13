import React from 'react';
import { MousePointerClick, ShieldAlert, X } from 'lucide-react';
import { Button, Modal } from './ui';
import { api, on } from '../lib/bridge';
import * as rtc from '../lib/webrtc';
import { useStore } from '../lib/store';
import type { ControlStatus } from '../lib/types';

/**
 * Saying yes to somebody driving this machine, and being able to see that
 * they are.
 *
 * Two pieces that belong together, because one without the other is the
 * dangerous arrangement. A prompt with no indicator means control is granted
 * once and then invisible; an indicator with no prompt means it was never
 * asked for.
 *
 * The prompt is deliberately not a friendly one. This is not a permission to
 * read something — it is a keyboard on this machine, in whatever has focus,
 * which may be a terminal or somebody's bank. It says so, and the safe answer
 * is the one that needs no thought.
 *
 * The banner is unconditional. However control was granted — asked for just
 * now, or by an entry on the always-allow list made weeks ago — the machine
 * says out loud that somebody is driving it, and offers one press to stop.
 */
export function ControlConsent() {
  const [status, setStatus] = React.useState<ControlStatus | null>(null);
  const peers = useStore((s) => s.peers);

  // The listeners below are registered once and read this later, so it has to
  // be a ref rather than the value captured at registration.
  const statusRef = React.useRef<ControlStatus | null>(null);
  statusRef.current = status;

  const refresh = React.useCallback(() => {
    void api.control
      .status()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  React.useEffect(() => {
    refresh();
    return on('control:changed', (next: ControlStatus) => setStatus(next));
  }, [refresh]);

  // A request arriving is the one moment this must appear without being
  // asked, so it listens for the message as well as the state.
  React.useEffect(() => on('control:message', () => refresh()), [refresh]);

  // Somebody driving this machine has asked for the good picture.
  //
  // Only from the device actually holding control — the ask is a message like
  // any other and a peer that has not been granted anything must not be able
  // to raise a share dialog on somebody's screen.
  React.useEffect(
    () =>
      on('control:message', (msg: { op?: string; from?: string }) => {
        if (msg.op !== 'screen' || !msg.from) return;
        const holder = statusRef.current?.holder;
        if (holder !== msg.from) return;
        void rtc.shareScreenWith(msg.from);
      }),
    [],
  );



  // Same reason as the wake list: an unimplemented command resolves with
  // null, and this one sits at the root of every screen.
  if (!status || typeof status !== 'object') return null;

  const nameFor = (deviceId: string) => {
    const peer = Object.values(peers).find((p) => p.deviceId === deviceId || p.id === deviceId);
    return peer?.name || peer?.deviceName || 'An unrecognised device';
  };

  return (
    <>
      {status.pending && (
        <Modal
          open
          onClose={() => void api.control.answer(status.pending!, false, false)}
          title={
            <span className="flex items-center gap-2">
              <ShieldAlert size={15} className="text-danger" />
              {nameFor(status.pending)} wants to control this device
            </span>
          }
          footer={
            <div className="flex items-center justify-end gap-2 flex-wrap">
              {/* Refusing is first and plainest: it is the answer that costs
                  nothing to get wrong. */}
              <Button
                variant="ghost"
                onClick={() => void api.control.answer(status.pending!, false, false)}
              >
                No
              </Button>
              <Button
                variant="outline"
                onClick={() => void api.control.answer(status.pending!, true, false)}
              >
                Allow once
              </Button>
              <Button
                variant="danger"
                onClick={() => void api.control.answer(status.pending!, true, true)}
              >
                Always allow this device
              </Button>
            </div>
          }
        >
          <div className="space-y-3 text-xs leading-relaxed">
            <p className="text-txt">
              They will be able to move the pointer and press keys on this machine, in
              whatever is on screen — not only in LANTern.
            </p>
            <p className="text-muted">
              You can stop it at any moment from the bar that appears while they are
              connected.
            </p>
            {/* The consequence of the third button, next to the third button,
                because "always" is the one people press without reading. */}
            <p className="text-2xs text-danger/90">
              Always allow means this device can take control again whenever it likes,
              without asking, including after a restart. Settings lists what you have
              allowed, and takes it back.
            </p>
          </div>
        </Modal>
      )}

      {status.holder && <ControlBanner who={nameFor(status.holder)} />}
    </>
  );
}

/**
 * Unmissable, and above everything.
 *
 * Somebody driving this machine is the one thing that must never be quiet.
 * It sits at the top rather than the corner because the corner is where
 * notifications go and notifications are what people learn to ignore.
 */
function ControlBanner({ who }: { who: string }) {
  return (
    <div className="fixed top-0 inset-x-0 z-[200] flex items-center justify-center gap-3 px-4 py-1.5 bg-danger text-white text-xs font-medium shadow-lg">
      <MousePointerClick size={14} />
      <span>{who} is controlling this device</span>
      <button
        onClick={() => void api.control.end()}
        className="ml-2 inline-flex items-center gap-1 rounded-input bg-black/25 px-2 py-0.5 hover:bg-black/40"
      >
        <X size={12} />
        Stop
      </button>
    </div>
  );
}
