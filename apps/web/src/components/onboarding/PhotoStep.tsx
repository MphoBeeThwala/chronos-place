'use client';

/**
 * Step 5 (TASKS M1.7, ADR-0024): profile photos, optional. Each file goes straight from the
 * browser to storage through a signed link, then the profile service re-makes it without hidden
 * data (such as location) and holds it for review. Order is changed with buttons, not dragging
 * (WCAG 2.2: every drag has a button alternative).
 */
import { gql, useMutation, useQuery } from '@apollo/client';
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { OPERATIONS } from '@/graphql/operations.generated';
import { messageOf } from '@/lib/graphql-errors';
import {
  checkPhotoFile,
  MAX_PHOTOS,
  moveId,
  type Photo,
  PHOTO_TYPES,
  variantUrl,
} from '@/lib/photos';

const MY_PHOTOS = gql(OPERATIONS.MyPhotos.text);
const CREATE_UPLOAD = gql(OPERATIONS.CreatePhotoUpload.text);
const COMPLETE_UPLOAD = gql(OPERATIONS.CompletePhotoUpload.text);
const REORDER = gql(OPERATIONS.ReorderPhotos.text);
const DELETE = gql(OPERATIONS.DeletePhoto.text);

const STATUS: Record<Photo['status'], string | undefined> = {
  PENDING: 'Waiting for review',
  APPROVED: undefined,
  REJECTED: 'Not approved. Delete it and try another.',
};

export function PhotoStep({ onFinish }: { onFinish: () => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<Photo[] | undefined>();
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | undefined>();
  const muted = { color: 'var(--color-text-muted)' };

  useQuery<{ me: { photos: Photo[] } }>(MY_PHOTOS, {
    fetchPolicy: 'network-only',
    onCompleted: (data) => {
      setPhotos(data.me.photos);
    },
    onError: () => {
      setPhotos([]);
    },
  });
  const [createUpload] = useMutation<{
    createPhotoUpload: { uploadId: string; uploadUrl: string };
  }>(CREATE_UPLOAD);
  const [completeUpload] = useMutation<{ completePhotoUpload: Photo }>(COMPLETE_UPLOAD);
  const [reorder] = useMutation<{ reorderPhotos: Photo[] }>(REORDER);
  const [remove] = useMutation<{ deletePhoto: Photo[] }>(DELETE);

  const list = photos ?? [];
  const full = list.length >= MAX_PHOTOS;

  const run = async (label: string, work: () => Promise<void>) => {
    setError(undefined);
    setBusy(true);
    setStatus(label);
    try {
      await work();
    } catch (err) {
      setError(err instanceof UploadError ? err.message : messageOf(err));
    } finally {
      setBusy(false);
      setStatus('');
    }
  };

  const upload = (file: File) =>
    run('Uploading your photo…', async () => {
      const problem = checkPhotoFile(file);
      if (problem) throw new UploadError(problem);
      const started = await createUpload({
        variables: { contentType: file.type, byteLength: file.size },
      });
      const link = started.data?.createPhotoUpload;
      if (!link) throw new UploadError('The upload could not start. Try again.');
      const sent = await fetch(link.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      }).catch(() => undefined);
      if (!sent?.ok)
        throw new UploadError('The upload did not finish. Check your connection and try again.');
      const done = await completeUpload({ variables: { uploadId: link.uploadId } });
      const photo = done.data?.completePhotoUpload;
      if (photo) setPhotos([...list, photo]);
    });

  const move = (index: number, delta: -1 | 1) =>
    run('Saving the new order…', async () => {
      const ids = moveId(
        list.map((p) => p.id),
        index,
        delta,
      );
      const result = await reorder({ variables: { photoIds: ids } });
      if (result.data) setPhotos(result.data.reorderPhotos);
    });

  const destroy = (photoId: string) =>
    run('Deleting the photo…', async () => {
      const result = await remove({ variables: { photoId } });
      if (result.data) setPhotos(result.data.deletePhoto);
      setConfirming(undefined);
    });

  return (
    <div className="space-y-6">
      <p style={muted}>
        Add up to {String(MAX_PHOTOS)} photos of yourself. We remove hidden information, such as
        where a photo was taken, before anyone sees it. New photos are reviewed before other members
        can see them.
      </p>

      <p aria-live="polite" className="text-sm font-medium">
        {status}
      </p>
      {error && (
        <p
          role="alert"
          className="rounded-lg px-4 py-3 text-sm"
          style={{ backgroundColor: 'var(--color-bg-muted)' }}
        >
          {error}
        </p>
      )}

      {list.length > 0 && (
        <ol
          className="grid grid-cols-2 gap-4"
          aria-label="Your photos, in the order others see them"
        >
          {list.map((photo, index) => {
            const label = `Photo ${String(index + 1)}`;
            const note = STATUS[photo.status];
            return (
              <li key={photo.id} className="space-y-2">
                <img
                  src={variantUrl(photo, 320)}
                  alt={`${label} of ${String(list.length)}`}
                  className="aspect-square w-full rounded-lg object-cover"
                  style={{ backgroundColor: 'var(--color-bg-muted)' }}
                />
                {note && (
                  <p className="text-sm" style={muted}>
                    {note}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || index === 0}
                    aria-label={`Move ${label.toLowerCase()} earlier`}
                    onClick={() => void move(index, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || index === list.length - 1}
                    aria-label={`Move ${label.toLowerCase()} later`}
                    onClick={() => void move(index, 1)}
                  >
                    ↓
                  </Button>
                  {confirming === photo.id ? (
                    <>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busy}
                        onClick={() => void destroy(photo.id)}
                      >
                        Delete {label.toLowerCase()}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setConfirming(undefined);
                        }}
                      >
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Delete ${label.toLowerCase()}`}
                      onClick={() => {
                        setConfirming(photo.id);
                      }}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {!full && (
        <div>
          <input
            ref={input}
            id={`${id}-file`}
            type="file"
            accept={PHOTO_TYPES.join(',')}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void upload(file);
            }}
          />
          <Button
            variant="secondary"
            fullWidth
            isLoading={busy && status.startsWith('Uploading')}
            disabled={busy || photos === undefined}
            onClick={() => input.current?.click()}
          >
            {list.length === 0 ? 'Add a photo' : 'Add another photo'}
          </Button>
          <p className="mt-2 text-sm" style={muted}>
            JPEG, PNG or WebP, up to 10 MB. {String(list.length)} of {String(MAX_PHOTOS)} added.
          </p>
        </div>
      )}

      <Button fullWidth disabled={busy} onClick={onFinish}>
        {list.length === 0 ? 'Skip for now' : 'Continue'}
      </Button>
    </div>
  );
}

/** A problem with the upload itself, already worded for the member. */
class UploadError extends Error {}
