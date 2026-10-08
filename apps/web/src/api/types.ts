/** Wire types of the Plakat REST API (see the REST API contract). */
import type { BrandKit, ImageMimeType, PlakatDocument } from '@plakat/schema';

export interface ApiErrorBody {
  error: { code: string; message: string; issues?: unknown };
}

export interface HealthResponse {
  ok: true;
  db: 'postgres' | 'pglite';
}

export interface Size {
  width: number;
  height: number;
}

export interface ProjectSummary {
  id: string;
  title: string;
  updatedAt: string;
  size: Size;
  pageCount: number;
  thumbnailUrl: string | null;
}

export interface ProjectRecord {
  id: string;
  document: PlakatDocument;
  version: number;
  updatedAt: string;
}

export interface SaveProjectResponse {
  id: string;
  version: number;
  updatedAt: string;
}

export interface TemplateSummary {
  id: string;
  title: string;
  category: string | null;
  size: Size;
  pageCount: number;
  slotCount: number;
  thumbnailUrl: string | null;
  builtIn: boolean;
}

export interface TemplateRecord {
  id: string;
  document: PlakatDocument;
  builtIn: boolean;
}

/** POST/PUT /api/templates answer `{ id, ... }`; extra fields are passed through. */
export interface TemplateWriteResponse {
  id: string;
  [key: string]: unknown;
}

export interface ThumbnailResponse {
  thumbnailUrl: string;
}

export interface UploadResponse {
  /** '/uploads/<sha256>.<ext>' (same-origin). */
  src: string;
  mimeType: ImageMimeType;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
}

export interface AssetProviderInfo {
  id: string;
  name: string;
  description: string;
  requiresKey: boolean;
  configured: boolean;
  homepage: string;
  licenseNote: string;
}

export interface AssetSearchItem {
  id: string;
  title: string;
  thumbUrl: string;
  previewUrl: string;
  width: number;
  height: number;
  creator: string | null;
  creatorUrl: string | null;
  license: string | null;
  licenseUrl: string | null;
  pageUrl: string | null;
}

export interface AssetSearchResponse {
  items: AssetSearchItem[];
  page: number;
  hasMore: boolean;
}

export interface ProviderAttribution {
  title: string | null;
  creator: string | null;
  creatorUrl: string | null;
  license: string | null;
  licenseUrl: string | null;
  pageUrl: string | null;
  provider: string;
}

export interface ProviderImportResponse extends UploadResponse {
  attribution: ProviderAttribution;
}

export interface ListResponse<T> {
  items: T[];
}

export type BrandKitList = ListResponse<BrandKit>;
