/**
 * Typed fetch client for the Plakat REST API. Every document / brand kit coming
 * from the server is run through loadDocument / loadBrandKit (schema §11: the only
 * sanctioned way to turn untrusted JSON into typed data).
 */
import { attributionLine } from './attribution.ts';
import {
  HTTP_URL_PATTERN,
  loadBrandKit,
  loadDocument,
  type AssetSource,
  type BrandKit,
  type ImageMimeType,
  type PlakatDocument,
} from '@plakat/schema';
import type {
  AssetProviderInfo,
  AssetSearchResponse,
  HealthResponse,
  ListResponse,
  ProjectRecord,
  ProjectSummary,
  ProviderImportResponse,
  SaveProjectResponse,
  TemplateRecord,
  TemplateSummary,
  TemplateWriteResponse,
  ThumbnailResponse,
  UploadResponse,
} from './types.ts';

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    /** HTTP status; 0 = network failure / aborted. */
    readonly status: number,
    /** Server error code (e.g. 'version_conflict', 'not_found'), or 'network_error' / 'aborted' / 'bad_response' / 'http_<status>'. */
    readonly code: string,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
  }
  get isConflict(): boolean {
    return this.status === 409 || this.code === 'version_conflict';
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export interface UploadOptions {
  /** 0..1 progress (uses XMLHttpRequest when available). */
  onProgress?: (fraction: number, loaded: number, total: number) => void;
  signal?: AbortSignal;
  /** Filename sent in the multipart part (default: file.name or 'image'). */
  filename?: string;
}

export interface ApiClientOptions {
  /** Prefix for every request, e.g. '' (same origin) or 'http://localhost:8787'. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Validate documents / brand kits from the server (default true). */
  validate?: boolean;
  /** XMLHttpRequest constructor for upload progress (default: global, if any). */
  XMLHttpRequest?: typeof XMLHttpRequest;
}

export type ApiClient = ReturnType<typeof createApiClient>;

function enc(id: string): string {
  return encodeURIComponent(id);
}

async function readError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const err = (body as { error?: { code?: unknown; message?: unknown; issues?: unknown } } | null)?.error;
  const code = typeof err?.code === 'string' ? err.code : res.status === 409 ? 'version_conflict' : `http_${res.status}`;
  const message = typeof err?.message === 'string' ? err.message : `${res.status} ${res.statusText || 'Request failed'}`;
  return new ApiError(res.status, code, message, err?.issues);
}

/** Parses Content-Disposition filename (RFC 6266 filename* or filename). */
export function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(header);
  return plain ? (plain[2] ?? plain[1] ?? '').trim() || null : null;
}

export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const doFetch: typeof fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const validate = options.validate !== false;
  const doc = (d: unknown): PlakatDocument => (validate ? loadDocument(d) : (d as PlakatDocument));
  const kit = (k: unknown): BrandKit => (validate ? loadBrandKit(k) : (k as BrandKit));

  async function raw(method: string, path: string, init: { body?: BodyInit | null; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        body: init.body ?? null,
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
        signal: init.signal ?? null,
        credentials: 'same-origin',
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw new ApiError(0, 'aborted', 'Request aborted');
      throw new ApiError(0, 'network_error', e instanceof Error ? e.message : 'Network error');
    }
    if (!res.ok) throw await readError(res);
    return res;
  }

  async function json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await raw(method, path, {
      body: body === undefined ? null : JSON.stringify(body),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      signal,
    });
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch {
      throw new ApiError(res.status, 'bad_response', 'Invalid JSON in server response');
    }
  }

  async function putPng(path: string, png: Blob): Promise<ThumbnailResponse> {
    const res = await raw('PUT', path, { body: png, headers: { 'Content-Type': 'image/png' } });
    return (await res.json()) as ThumbnailResponse;
  }

  function uploadXhr(Xhr: typeof XMLHttpRequest, form: FormData, opts: UploadOptions): Promise<UploadResponse> {
    return new Promise((resolve, reject) => {
      const xhr = new Xhr();
      xhr.open('POST', `${baseUrl}/api/uploads`);
      xhr.responseType = 'text';
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.total ? e.loaded / e.total : 0, e.loaded, e.total);
      };
      xhr.onload = () => {
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* handled below */
        }
        if (xhr.status >= 200 && xhr.status < 300 && body) {
          opts.onProgress?.(1, 1, 1);
          resolve(body as UploadResponse);
          return;
        }
        const err = (body as { error?: { code?: string; message?: string; issues?: unknown } } | null)?.error;
        reject(new ApiError(xhr.status, err?.code ?? `http_${xhr.status}`, err?.message ?? `Upload failed (${xhr.status})`, err?.issues));
      };
      xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Network error during upload'));
      xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload aborted'));
      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(new ApiError(0, 'aborted', 'Upload aborted'));
          return;
        }
        opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(form);
    });
  }

  return {
    baseUrl,

    health: () => json<HealthResponse>('GET', '/api/health'),

    // --- projects ---------------------------------------------------------------
    listProjects: async (): Promise<ProjectSummary[]> => (await json<ListResponse<ProjectSummary>>('GET', '/api/projects')).items,
    async createProject(document: PlakatDocument): Promise<ProjectRecord> {
      const r = await json<ProjectRecord>('POST', '/api/projects', { document });
      return { ...r, document: doc(r.document) };
    },
    async getProject(id: string): Promise<ProjectRecord> {
      const r = await json<ProjectRecord>('GET', `/api/projects/${enc(id)}`);
      return { ...r, document: doc(r.document) };
    },
    /** Throws ApiError with `isConflict` (409 version_conflict) when baseVersion is stale. */
    saveProject: (id: string, document: PlakatDocument, baseVersion: number | null) =>
      json<SaveProjectResponse>('PUT', `/api/projects/${enc(id)}`, { document, baseVersion }),
    deleteProject: async (id: string): Promise<void> => {
      await raw('DELETE', `/api/projects/${enc(id)}`);
    },
    uploadProjectThumbnail: (id: string, png: Blob) => putPng(`/api/projects/${enc(id)}/thumbnail`, png),

    // --- templates -----------------------------------------------------------------
    async listTemplates(query: { category?: string | null; q?: string } = {}): Promise<TemplateSummary[]> {
      const params = new URLSearchParams();
      if (query.category) params.set('category', query.category);
      if (query.q) params.set('q', query.q);
      const qs = params.toString();
      return (await json<ListResponse<TemplateSummary>>('GET', `/api/templates${qs ? `?${qs}` : ''}`)).items;
    },
    async getTemplate(id: string): Promise<TemplateRecord> {
      const r = await json<TemplateRecord>('GET', `/api/templates/${enc(id)}`);
      return { ...r, document: doc(r.document) };
    },
    createTemplate: (document: PlakatDocument) => json<TemplateWriteResponse>('POST', '/api/templates', { document }),
    updateTemplate: (id: string, document: PlakatDocument) => json<TemplateWriteResponse>('PUT', `/api/templates/${enc(id)}`, { document }),
    /** Built-in templates answer 403 (ApiError status 403). */
    deleteTemplate: async (id: string): Promise<void> => {
      await raw('DELETE', `/api/templates/${enc(id)}`);
    },
    /** URL of the portable .plakat.json download (usable as an <a href download>). */
    templateFileUrl: (id: string) => `${baseUrl}/api/templates/${enc(id)}/file`,
    async downloadTemplateFile(id: string): Promise<{ blob: Blob; filename: string }> {
      const res = await raw('GET', `/api/templates/${enc(id)}/file`, { headers: { Accept: 'application/json, application/vnd.plakat+json' } });
      const blob = await res.blob();
      return { blob, filename: parseContentDispositionFilename(res.headers.get('Content-Disposition')) ?? `${id}.plakat.json` };
    },
    /** Imports .plakat.json text (or a File/Blob holding it). */
    async importTemplate(file: string | Blob): Promise<{ id: string }> {
      const text = typeof file === 'string' ? file : await file.text();
      const res = await raw('POST', '/api/templates/import', { body: text, headers: { 'Content-Type': 'application/json' } });
      return (await res.json()) as { id: string };
    },
    uploadTemplateThumbnail: (id: string, png: Blob) => putPng(`/api/templates/${enc(id)}/thumbnail`, png),

    // --- brand kits ------------------------------------------------------------------
    listBrandKits: async (): Promise<BrandKit[]> => (await json<ListResponse<unknown>>('GET', '/api/brand-kits')).items.map(kit),
    createBrandKit: async (k: BrandKit): Promise<BrandKit> => kit((await json<{ kit: unknown }>('POST', '/api/brand-kits', { kit: k })).kit),
    getBrandKit: async (id: string): Promise<BrandKit> => {
      const r = await json<Record<string, unknown>>('GET', `/api/brand-kits/${enc(id)}`);
      return kit(r && typeof r === 'object' && 'kit' in r ? r['kit'] : r);
    },
    updateBrandKit: async (id: string, k: BrandKit): Promise<BrandKit> => {
      const r = await json<{ kit?: unknown } | undefined>('PUT', `/api/brand-kits/${enc(id)}`, { kit: k });
      return r && typeof r === 'object' && 'kit' in r && r.kit ? kit(r.kit) : k;
    },
    deleteBrandKit: async (id: string): Promise<void> => {
      await raw('DELETE', `/api/brand-kits/${enc(id)}`);
    },

    // --- uploads -------------------------------------------------------------------------
    /** POST /api/uploads (multipart "file"). Progress via XHR when `onProgress` is given. */
    async upload(file: Blob, opts: UploadOptions = {}): Promise<UploadResponse> {
      const form = new FormData();
      const name = opts.filename ?? (file instanceof File ? file.name : 'image');
      form.append('file', file, name);
      const Xhr = options.XMLHttpRequest ?? (typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : undefined);
      if (opts.onProgress && Xhr) return uploadXhr(Xhr, form, opts);
      const res = await raw('POST', '/api/uploads', { body: form, signal: opts.signal });
      const body = (await res.json()) as UploadResponse;
      opts.onProgress?.(1, 1, 1);
      return body;
    },

    // --- asset providers -------------------------------------------------------------------
    listAssetProviders: async (): Promise<AssetProviderInfo[]> => (await json<ListResponse<AssetProviderInfo>>('GET', '/api/asset-providers')).items,
    searchAssets(providerId: string, query: { q: string; page?: number; perPage?: number }, signal?: AbortSignal): Promise<AssetSearchResponse> {
      const params = new URLSearchParams({ q: query.q });
      if (query.page !== undefined) params.set('page', String(query.page));
      if (query.perPage !== undefined) params.set('perPage', String(query.perPage));
      return json<AssetSearchResponse>('GET', `/api/asset-providers/${enc(providerId)}/search?${params}`, undefined, signal);
    },
    importAsset: (providerId: string, itemId: string) => json<ProviderImportResponse>('POST', `/api/asset-providers/${enc(providerId)}/import`, { itemId }),
  };
}

/** The default same-origin client (dev: vite proxies /api and /uploads to :8787). */
export const api: ApiClient = createApiClient();

// ---------------------------------------------------------------------------
// Response -> editor input helpers
// ---------------------------------------------------------------------------

const httpOrNull = (v: string | null | undefined): string | null => (v && HTTP_URL_PATTERN.test(v) && v.length <= 2000 ? v : null);

/** An upload response as the store's AssetInput (actions.addImage / replaceImage / setPageBackground). */
export function uploadToAssetInput(
  res: UploadResponse,
  name = '',
): { src: string; width: number; height: number; mimeType: ImageMimeType; name: string; source: AssetSource } {
  return {
    src: res.src,
    width: res.width,
    height: res.height,
    mimeType: res.mimeType,
    name: name.slice(0, 200),
    source: { provider: 'upload', externalId: res.sha256, pageUrl: null, author: null, license: null, licenseUrl: null, attribution: null },
  };
}

/** A provider import as AssetInput, with attribution preserved in `source` (schema §8). */
export function providerImportToAssetInput(
  res: ProviderImportResponse,
  itemId: string,
): { src: string; width: number; height: number; mimeType: ImageMimeType; name: string; source: AssetSource } {
  const a = res.attribution;
  return {
    src: res.src,
    width: res.width,
    height: res.height,
    mimeType: res.mimeType,
    name: (a.title ?? '').slice(0, 200),
    source: {
      provider: (a.provider || 'provider').slice(0, 64),
      externalId: itemId.slice(0, 500),
      pageUrl: httpOrNull(a.pageUrl),
      author: a.creator ? a.creator.slice(0, 500) : null,
      license: a.license ? a.license.slice(0, 200) : null,
      licenseUrl: httpOrNull(a.licenseUrl),
      attribution: attributionLine(a).slice(0, 2000) || null,
    },
  };
}
