/**
 * The approved policy texts as simple blocks (built by scripts/legal-gen.mjs from docs/legal/),
 * and how the page shows them. No markdown library: the texts use a small, fixed subset.
 */
import type { ReactNode } from 'react';

export type Span =
  | { t: 'text'; v: string }
  | { t: 'b'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; v: string; href: string };

export type Block =
  | { t: 'h2'; c: Span[] }
  | { t: 'p'; c: Span[] }
  | { t: 'ul' | 'ol'; items: Span[][] }
  | { t: 'table'; head: Span[][]; rows: Span[][][] };

export interface PolicyText {
  version: string;
  title: string;
  blocks: Block[];
}

function Spans({ spans }: { spans: Span[] }): ReactNode {
  return spans.map((span, i) => {
    switch (span.t) {
      case 'b':
        return <strong key={i}>{span.v}</strong>;
      case 'code':
        return <code key={i}>{span.v}</code>;
      case 'link':
        return (
          <a
            key={i}
            href={span.href}
            className="underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {span.v}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        );
      default:
        return span.v;
    }
  });
}

const cell = 'border px-3 py-2 align-top text-left border-[var(--color-border)]';

export function PolicyBlocks({ blocks }: { blocks: Block[] }) {
  return blocks.map((block, i) => {
    switch (block.t) {
      case 'h2':
        return (
          <h2 key={i} className="mt-8 text-xl font-semibold">
            <Spans spans={block.c} />
          </h2>
        );
      case 'p':
        return (
          <p key={i}>
            <Spans spans={block.c} />
          </p>
        );
      case 'ul':
      case 'ol': {
        const List = block.t;
        return (
          <List
            key={i}
            className={`space-y-1 pl-6 ${block.t === 'ul' ? 'list-disc' : 'list-decimal'}`}
          >
            {block.items.map((item, j) => (
              <li key={j}>
                <Spans spans={item} />
              </li>
            ))}
          </List>
        );
      }
      case 'table': {
        const hasHead = block.head.some((h) => h.length > 0);
        return (
          <div key={i} className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              {hasHead && (
                <thead>
                  <tr>
                    {block.head.map((h, j) => (
                      <th key={j} scope="col" className={`${cell} font-semibold`}>
                        <Spans spans={h} />
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {block.rows.map((row, j) => (
                  <tr key={j}>
                    {row.map((c, k) =>
                      k === 0 ? (
                        <th key={k} scope="row" className={`${cell} font-medium`}>
                          <Spans spans={c} />
                        </th>
                      ) : (
                        <td key={k} className={cell}>
                          <Spans spans={c} />
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
    }
  });
}
