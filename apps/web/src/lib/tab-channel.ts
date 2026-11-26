/**
 * Messages between this member's open tabs of the app, in memory only: nothing is written to the
 * device (ADR-0017). Activity in any tab keeps them all signed in; quick exit and an idle sign-out
 * in one tab clear the others too.
 */
export type TabMessage =
  { type: 'activity'; at: number } | { type: 'quick-exit' } | { type: 'signed-out' };

const NAME = 'chronos-tabs';

export interface TabChannel {
  post(message: TabMessage): void;
  close(): void;
}

export function openTabChannel(onMessage: (message: TabMessage) => void): TabChannel {
  if (typeof BroadcastChannel === 'undefined')
    return { post: () => undefined, close: () => undefined };
  const channel = new BroadcastChannel(NAME);
  channel.onmessage = (event: MessageEvent<TabMessage>) => {
    onMessage(event.data);
  };
  return {
    post: (message) => {
      channel.postMessage(message);
    },
    close: () => {
      channel.close();
    },
  };
}
