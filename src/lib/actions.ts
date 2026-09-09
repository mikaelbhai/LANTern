import { api } from './bridge';
import { useStore } from './store';
import type { CallKind, GameKind } from './types';
import { mimeKind } from './utils';

/** Opens (creating if needed) the DM with a peer and focuses the Chats screen. */
export function openDm(peerId: string): string {
  const s = useStore.getState();
  const roomId = s.ensureDm(peerId);
  s.openRoom(roomId);
  return roomId;
}

export function callPeer(peerId: string, kind: CallKind) {
  useStore.getState().startCall(kind, [peerId]);
}

/**
 * Sends files to a peer by absolute path.
 *
 * Paths, not `File` objects: the sender's HTTP server opens the file itself
 * and streams it, which is what makes a multi-gigabyte send possible without
 * reading it into memory first. A browser `File` has no path, so this is only
 * reachable through the native picker.
 */
export async function sendFilesToPeer(peerId: string, paths: string[]) {
  if (!paths.length) return;
  const s = useStore.getState();
  const created = await api.files.offer(peerId, paths);
  s.addTransfers(created);

  const failed = created.filter((t) => t.state === 'failed').length;
  const names = paths.map((p) => p.split(/[\\/]/).pop() ?? p);

  if (!created.length || failed === created.length) {
    s.toast({
      kind: 'error',
      title: 'Could not send',
      body: `No live link to ${s.peers[peerId]?.name ?? 'that device'}.`,
    });
    return;
  }
  s.toast({
    kind: 'info',
    title: created.length === 1 ? 'Sending 1 file' : `Sending ${created.length} files`,
    body: names.slice(0, 3).join(', '),
  });
}

export function challengePeer(peerId: string, game: GameKind) {
  const s = useStore.getState();
  s.setActiveGame({ kind: game, opponentId: peerId });
  s.toast({
    kind: 'info',
    title: 'Challenge sent',
    body: `${s.peers[peerId]?.name ?? 'Peer'} has been invited to play ${game}.`,
  });
}

export function attachmentFromFile(file: File, dataUrl?: string) {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    kind: mimeKind(file.type, file.name),
    dataUrl,
  };
}
