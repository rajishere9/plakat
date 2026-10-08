import type { ProviderAttribution } from './types.ts';

/** Human attribution line, e.g. '"Sunset" by Jane Doe, CC BY 2.0 (via Openverse)'. */
export function attributionLine(a: Pick<ProviderAttribution, 'title' | 'creator' | 'license' | 'provider'>): string {
  const parts: string[] = [];
  if (a.title) parts.push(`"${a.title}"`);
  if (a.creator) parts.push(`${parts.length ? 'by ' : 'By '}${a.creator}`);
  let line = parts.join(' ');
  if (a.license) line += `${line ? ', ' : ''}${a.license}`;
  if (a.provider) line += `${line ? ' ' : ''}(via ${a.provider})`;
  return line;
}
