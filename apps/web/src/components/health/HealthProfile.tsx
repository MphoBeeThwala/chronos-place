'use client';

/**
 * The member's health profile (TASKS M2.8): conditions, own words, who can see it, condition
 * filters, and who has seen it. Every health operation runs with fetchPolicy `no-cache`, so nothing
 * health-related enters Apollo's cache, and nothing is written to any browser storage.
 */
import { gql, useMutation, useQuery } from '@apollo/client';
import type {
  ConditionStatus,
  ConditionTaxonomyEntry,
  HealthCondition,
  HealthProfile as HealthProfileData,
  HealthViewer,
  HealthVisibility,
} from '@chronos/contracts/graphql/types';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { OPERATIONS } from '@/graphql/operations.generated';
import { messageOf } from '@/lib/graphql-errors';
import {
  canSave,
  COPY,
  MAX_CONDITIONS,
  MAX_TEXT,
  OTHER_CODE,
  STATUS_LABELS,
  viewerLine,
  VISIBILITY_OPTIONS,
} from './health-copy';

const PAGE = gql(OPERATIONS.HealthPage.text);
const VIEWERS = gql(OPERATIONS.HealthViewers.text);
const UPSERT = gql(OPERATIONS.UpsertHealthProfile.text);
const SET_VISIBILITY = gql(OPERATIONS.SetHealthVisibility.text);
const SET_FILTERS = gql(OPERATIONS.SetHealthFilters.text);

const NO_CACHE = { fetchPolicy: 'no-cache' } as const;

interface PageData {
  myHealthProfile: HealthProfileData | null;
  conditionTaxonomy: ConditionTaxonomyEntry[];
  myHealthFilters: string[];
}

const muted = { color: 'var(--color-text-muted)' };
const field =
  'mt-1 block w-full rounded-lg border px-3 py-2 text-base focus-visible:outline focus-visible:outline-2';
const fieldStyle = {
  borderColor: 'var(--color-border-strong)',
  backgroundColor: 'var(--color-bg)',
  color: 'var(--color-text)',
};

export function HealthProfile() {
  const page = useQuery<PageData>(PAGE, NO_CACHE);
  const viewers = useQuery<{ healthViewers: HealthViewer[] }>(VIEWERS, NO_CACHE);
  // Kept here, not in the editor: the editor starts afresh from each saved version.
  const [editorMessage, setEditorMessage] = useState<EditorMessage>({});

  if (page.loading) return <p role="status">Loading…</p>;
  if (page.error || !page.data) {
    return <p role="alert">{messageOf(page.error)}</p>;
  }
  const { myHealthProfile, conditionTaxonomy, myHealthFilters } = page.data;
  const labels = new Map(conditionTaxonomy.map((e) => [e.code, e.label]));
  return (
    <div className="space-y-10">
      <ProfileEditor
        key={myHealthProfile?.version ?? 0}
        profile={myHealthProfile}
        taxonomy={conditionTaxonomy}
        labels={labels}
        reload={() => page.refetch()}
        message={editorMessage}
        setMessage={setEditorMessage}
      />
      {myHealthProfile && <Visibility profile={myHealthProfile} reload={() => page.refetch()} />}
      {myHealthProfile?.visibility === 'PROFILE' && (
        <Filters
          optIn={myHealthProfile.filterOptIn}
          wanted={myHealthFilters}
          taxonomy={conditionTaxonomy.filter((e) => e.code !== OTHER_CODE)}
          reload={() => page.refetch()}
        />
      )}
      <Viewers viewers={viewers.data?.healthViewers} error={viewers.error} />
    </div>
  );
}

interface EditorMessage {
  status?: string;
  error?: string;
}

function ProfileEditor(props: {
  profile: HealthProfileData | null;
  taxonomy: ConditionTaxonomyEntry[];
  labels: Map<string, string>;
  reload: () => Promise<unknown>;
  message: EditorMessage;
  setMessage: (message: EditorMessage) => void;
}) {
  const id = useId();
  const [conditions, setConditions] = useState<HealthCondition[]>(props.profile?.conditions ?? []);
  const [freeText, setFreeText] = useState(props.profile?.freeText ?? '');
  const [note, setNote] = useState(props.profile?.note ?? '');
  const [adding, setAdding] = useState('');
  const { status, error } = props.message;
  const [upsert, { loading }] = useMutation(UPSERT, NO_CACHE);
  const available = props.taxonomy.filter((e) => !conditions.some((c) => c.code === e.code));

  const setStatusOf = (code: string, value: ConditionStatus) => {
    setConditions((list) => list.map((c) => (c.code === code ? { ...c, status: value } : c)));
  };
  const add = () => {
    if (adding === '' || conditions.length >= MAX_CONDITIONS) return;
    setConditions((list) => [...list, { code: adding, status: 'LIVING_WITH' }]);
    setAdding('');
  };
  const save = async () => {
    props.setMessage({});
    try {
      await upsert({
        variables: {
          input: {
            conditions: conditions.map((c) => ({ code: c.code, status: c.status })),
            freeText: freeText.trim() === '' ? null : freeText,
            note: note.trim() === '' ? null : note,
            expectedVersion: props.profile?.version ?? 0,
          },
        },
      });
      props.setMessage({ status: COPY.saved });
      await props.reload();
    } catch (err) {
      const code = (err as { graphQLErrors?: { extensions?: { code?: string } }[] })
        .graphQLErrors?.[0]?.extensions?.code;
      if (code === 'CONFLICT') {
        props.setMessage({ error: COPY.conflict });
        await props.reload();
      } else {
        props.setMessage({ error: messageOf(err) });
      }
    }
  };

  return (
    <section aria-labelledby={`${id}-conditions`} className="space-y-4">
      <h2 id={`${id}-conditions`} className="text-lg font-semibold">
        Conditions
      </h2>
      <p style={muted}>{COPY.conditions}</p>
      <ul className="space-y-3">
        {conditions.map((c) => {
          const label = props.labels.get(c.code) ?? c.code;
          return (
            <li key={c.code}>
              <fieldset
                className="rounded-lg border p-3"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <legend className="px-1 font-medium">{label}</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {(Object.keys(STATUS_LABELS) as ConditionStatus[]).map((s) => (
                    <label key={s} className="touch-target inline-flex items-center gap-2">
                      <input
                        type="radio"
                        name={`${id}-${c.code}`}
                        checked={c.status === s}
                        onChange={() => {
                          setStatusOf(c.code, s);
                        }}
                      />
                      {STATUS_LABELS[s]}
                    </label>
                  ))}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${label}`}
                  onClick={() => {
                    setConditions((list) => list.filter((x) => x.code !== c.code));
                  }}
                >
                  Remove
                </Button>
              </fieldset>
            </li>
          );
        })}
      </ul>
      {conditions.length < MAX_CONDITIONS && available.length > 0 && (
        <div className="flex items-end gap-2">
          <label className="flex-1">
            Add a condition
            <select
              className={field}
              style={fieldStyle}
              value={adding}
              onChange={(e) => {
                setAdding(e.target.value);
              }}
            >
              <option value="">Choose…</option>
              {available.map((e) => (
                <option key={e.code} value={e.code}>
                  {e.label}
                </option>
              ))}
            </select>
          </label>
          <Button variant="secondary" onClick={add} disabled={adding === ''}>
            Add
          </Button>
        </div>
      )}
      <label className="block">
        {COPY.ownWords}
        <textarea
          className={field}
          style={fieldStyle}
          rows={3}
          maxLength={MAX_TEXT}
          value={freeText}
          aria-describedby={`${id}-own-help`}
          autoComplete="off"
          onChange={(e) => {
            setFreeText(e.target.value);
          }}
        />
      </label>
      <p id={`${id}-own-help`} className="text-sm" style={muted}>
        {COPY.ownWordsHelp}
      </p>
      <label className="block">
        {COPY.note}
        <textarea
          className={field}
          style={fieldStyle}
          rows={3}
          maxLength={MAX_TEXT}
          value={note}
          aria-describedby={`${id}-note-help`}
          autoComplete="off"
          onChange={(e) => {
            setNote(e.target.value);
          }}
        />
      </label>
      <p id={`${id}-note-help`} className="text-sm" style={muted}>
        {COPY.noteHelp}
      </p>
      <Button
        onClick={() => void save()}
        isLoading={loading}
        disabled={loading || !canSave({ conditions, freeText, note })}
      >
        Save
      </Button>
      <p role="status" aria-live="polite">
        {status}
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function Visibility(props: { profile: HealthProfileData; reload: () => Promise<unknown> }) {
  const id = useId();
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [setVisibility, { loading }] = useMutation(SET_VISIBILITY, NO_CACHE);
  const choose = async (visibility: HealthVisibility) => {
    setStatus('');
    setError(undefined);
    try {
      await setVisibility({ variables: { visibility } });
      await props.reload();
      setStatus(COPY.saved);
    } catch (err) {
      setError(messageOf(err));
    }
  };
  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-3">
      <fieldset disabled={loading}>
        <legend id={`${id}-heading`} className="mb-2 text-lg font-semibold">
          {COPY.visibilityHeading}
        </legend>
        <div className="space-y-2">
          {VISIBILITY_OPTIONS.map((o) => (
            <div key={o.value}>
              <label className="touch-target inline-flex items-center gap-3 font-medium">
                <input
                  type="radio"
                  name={`${id}-visibility`}
                  checked={props.profile.visibility === o.value}
                  aria-describedby={`${id}-${o.value}`}
                  onChange={() => void choose(o.value)}
                />
                {o.label}
              </label>
              <p id={`${id}-${o.value}`} className="ml-7 text-sm" style={muted}>
                {o.description}
              </p>
            </div>
          ))}
        </div>
      </fieldset>
      <p role="status" aria-live="polite">
        {status}
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function Filters(props: {
  optIn: boolean;
  wanted: string[];
  taxonomy: ConditionTaxonomyEntry[];
  reload: () => Promise<unknown>;
}) {
  const id = useId();
  const [wanted, setWanted] = useState<string[]>(props.wanted);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [setVisibility, { loading: switching }] = useMutation(SET_VISIBILITY, NO_CACHE);
  const [setFilters, { loading: saving }] = useMutation(SET_FILTERS, NO_CACHE);
  useEffect(() => {
    setWanted(props.wanted);
  }, [props.wanted]);

  const run = async (action: () => Promise<unknown>) => {
    setStatus('');
    setError(undefined);
    try {
      await action();
      await props.reload();
      setStatus(COPY.saved);
    } catch (err) {
      setError(messageOf(err));
    }
  };
  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-3">
      <h2 id={`${id}-heading`} className="text-lg font-semibold">
        {COPY.filtersHeading}
      </h2>
      <p id={`${id}-help`} style={muted}>
        {COPY.filtersHelp}
      </p>
      <label className="touch-target inline-flex items-center gap-2">
        <input
          type="checkbox"
          checked={props.optIn}
          disabled={switching}
          aria-describedby={`${id}-help`}
          onChange={(e) =>
            void run(() =>
              setVisibility({
                variables: { visibility: 'PROFILE', filterOptIn: e.target.checked },
              }),
            )
          }
        />
        {COPY.filtersHeading}
      </label>
      {props.optIn && (
        <fieldset className="space-y-1">
          <legend className="font-medium">Conditions to filter by</legend>
          {props.taxonomy.map((e) => (
            <label key={e.code} className="touch-target flex items-center gap-2">
              <input
                type="checkbox"
                checked={wanted.includes(e.code)}
                disabled={!wanted.includes(e.code) && wanted.length >= MAX_CONDITIONS}
                onChange={(event) => {
                  setWanted((list) =>
                    event.target.checked ? [...list, e.code] : list.filter((c) => c !== e.code),
                  );
                }}
              />
              {e.label}
            </label>
          ))}
          <Button
            variant="secondary"
            isLoading={saving}
            disabled={saving}
            onClick={() => void run(() => setFilters({ variables: { conditionCodes: wanted } }))}
          >
            Save filters
          </Button>
        </fieldset>
      )}
      <p role="status" aria-live="polite">
        {status}
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function Viewers(props: { viewers: HealthViewer[] | undefined; error: unknown }) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-3">
      <h2 id={`${id}-heading`} className="text-lg font-semibold">
        {COPY.viewersHeading}
      </h2>
      {props.error ? (
        <p role="alert">{messageOf(props.error)}</p>
      ) : props.viewers === undefined ? (
        <p role="status">Loading…</p>
      ) : props.viewers.length === 0 ? (
        <p style={muted}>{COPY.viewersEmpty}</p>
      ) : (
        <ul className="space-y-2">
          {props.viewers.map((v, i) => (
            <li key={v.viewer?.id ?? `hidden-${String(i)}`}>
              {viewerLine({
                name: v.viewer?.displayName ?? null,
                lastViewedAt: v.lastViewedAt,
                viewCount: v.viewCount,
                hasActiveGrant: v.hasActiveGrant,
              })}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
