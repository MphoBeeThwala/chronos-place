'use client';

/**
 * Mounts Smile ID's capture component (ADR-0022, decision 2). It is bundled from npm, pinned and
 * patched to load nothing from other sites (patches/), so it runs from our own origin and makes
 * no network requests: it only hands the images back to this page. The camera is allowed on the
 * /verify route only (Permissions-Policy in next.config.ts).
 */
import { useEffect, useRef } from 'react';
import { captureBody, type CaptureBody, type ComputedImages } from '@/lib/verification';

/**
 * Stops every camera track the component opened. Its disconnectedCallback clears the screen but
 * leaves the stream running, which would keep the camera on after the member leaves.
 */
function stopCamera(element: HTMLElement): void {
  const streams = new Set<MediaStream>();
  const own = (element as unknown as { _stream?: unknown })._stream;
  if (own instanceof MediaStream) streams.add(own);
  for (const video of element.shadowRoot?.querySelectorAll('video') ?? []) {
    if (video.srcObject instanceof MediaStream) streams.add(video.srcObject);
  }
  for (const stream of streams) for (const track of stream.getTracks()) track.stop();
}

export function SelfieCamera({
  onCapture,
  onCancel,
  onInvalid,
}: {
  onCapture: (body: CaptureBody) => void;
  onCancel: () => void;
  onInvalid: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onCapture, onCancel, onInvalid });
  handlers.current = { onCapture, onCancel, onInvalid };

  useEffect(() => {
    const container = host.current;
    if (!container) return undefined;
    let element: HTMLElement | undefined;
    let cancelled = false;

    const computed = (event: Event) => {
      const body = captureBody((event as CustomEvent<ComputedImages>).detail);
      if (body) handlers.current.onCapture(body);
      else handlers.current.onInvalid();
    };
    const cancel = () => {
      if (element) stopCamera(element);
      handlers.current.onCancel();
    };

    void import('@smile_identity/smart-camera-web').then(() => {
      if (cancelled) return;
      element = document.createElement('smart-camera-web');
      element.addEventListener('imagesComputed', computed);
      element.addEventListener('close', cancel);
      element.addEventListener('backExit', cancel);
      container.replaceChildren(element);
    });

    return () => {
      cancelled = true;
      element?.removeEventListener('imagesComputed', computed);
      element?.removeEventListener('close', cancel);
      element?.removeEventListener('backExit', cancel);
      if (element) stopCamera(element);
      container.replaceChildren();
    };
  }, []);

  return <div ref={host} aria-label="Selfie camera" role="region" />;
}
