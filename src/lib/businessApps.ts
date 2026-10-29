import { errorCause, isRecord } from './guards.js';
import { KizenApiError } from './kizenClient.js';
import type { KizenClient } from './kizenTypes.js';

/**
 * Wire types and an API wrapper for per-business "Business Apps"
 * (`/external-integrations/plugin-apps/{businessId}/…`) and the S3 file upload/download they use.
 */

export type BusinessAppStatus = 'live' | 'preview' | 'disabled';

export type BusinessAppVersionStatus = 'live' | 'released' | 'preview';

export interface BusinessAppPreviewOwner {
  id: string;
  full_name: string;
}

export interface BusinessAppVersionRow {
  /** "0" for a preview, else the release number. */
  version: string;
  status: BusinessAppVersionStatus;
  preview_owner: BusinessAppPreviewOwner | null;
  /** A preview's: the users using it now, its owner included. Null for a release. */
  active_users_count: number | null;
  /** A preview's: the users who have it installed. Null for a release. */
  installed_count: number | null;
  /** Whether this is the version the signed-in user is using. */
  is_current_for_viewer: boolean;
  updated: string | null;
  published_at: string | null;
  published_by: unknown;
  built_by: unknown;
  definition_url: string | null;
}

export interface BusinessAppRow {
  /** The business-suffixed name, `<base>_<6 hex of the business id>`. */
  api_name: string;
  base_api_name: string;
  name: string;
  status: BusinessAppStatus;
  live_version: string | null;
  has_releases: boolean;
  updated: string | null;
  current_version: string | null;
  published_by: unknown;
  versions: BusinessAppVersionRow[];
}

export interface BusinessAppDetail extends BusinessAppRow {
  version: string;
  is_preview: boolean;
  preview_owner: BusinessAppPreviewOwner | null;
  thumbnail: unknown;
  published_at: string | null;
  [key: string]: unknown;
}

export interface BusinessAppArtifacts {
  data_adornments: unknown[];
  floating_frames: unknown[];
  custom_blocks: unknown[];
  routable_pages: unknown[];
  toolbar_items: unknown[];
  object_settings_menu_items: unknown[];
  calendar_sources: unknown[];
  js_action_templates: unknown[];
  route_script_templates: unknown[];
  automation_action_configs: unknown[];
}

/** The body of `POST …/{businessId}/publish`. `api_name` is the base (unsuffixed) name. */
export interface BusinessAppPublishBody {
  name: string;
  api_name: string;
  engine: string;
  description?: string;
  agentic_description?: string;
  external_link?: string;
  config_template?: Record<string, unknown>;
  services: unknown[];
  base_config: Record<string, unknown>;
  artifacts: BusinessAppArtifacts;
  catalogs?: string[];
  release_notes?: string;
  /** true publishes a new numbered release; false updates the caller's preview. */
  release: boolean;
  /** The S3 file id of the source zip (`plugin_app_source_filesystem`). */
  source_filesystem_package: string;
  /** The S3 file id of the thumbnail (`public_image`); a release requires one. */
  thumbnail: string | null;
}

/** A stored version or preview, in the publish payload's shape (api_name is the base name). */
export type BusinessAppDefinition = Omit<
  BusinessAppPublishBody,
  'release' | 'source_filesystem_package'
> & {
  source_filesystem_package: string | null;
  version?: string;
  [key: string]: unknown;
};

export interface PublishResult {
  api_name: string;
  base_api_name: string;
  /** "0" for a preview, else the new release number. */
  version: string;
}

export interface PromoteResult {
  api_name: string;
  version: string;
}

export type UploadSource = 'plugin_app_source_filesystem' | 'public_image';

export interface UploadFileOptions {
  filename: string;
  contentType: string;
  source: UploadSource;
  /** Sent to /s3/success as `is_public=true`; thumbnails need it. */
  isPublic?: boolean;
}

/** A JS action template as an association names it. */
export interface ActionAssociationTemplate {
  id: string;
  api_name: string;
  name: string;
  hint_object_name: string | null;
}

/** The object an association links to; `name` is its api name (`client_client`). */
export interface ActionAssociationObject {
  id: string;
  name: string;
  object_name?: string;
  entity_name?: string;
}

/**
 * One JS action template ↔ object link of the app's install. The server lists only links whose
 * template is in the install's Live version.
 */
export interface ActionAssociation {
  id: string;
  /** Whether the action shows in that object's Perform Action menus; null when never set. */
  include_perform_action: boolean | null;
  browser_js_action_template: ActionAssociationTemplate;
  custom_object: ActionAssociationObject;
}

export interface CreateActionAssociationInput {
  /** The suffixed api_name of the app. */
  appApiName: string;
  actionApiName: string;
  objectId: string;
  includePerformAction: boolean;
}

/** An object actions can be linked to, Contacts included (`custom_only=false`). */
export interface BusinessObject {
  id: string;
  /** The api name (`client_client`). */
  name: string;
  /** The display name (`Contacts`). */
  objectName: string;
  entityName: string | null;
}

export type BusinessAppErrorCode = 'thumbnail_required' | 'file_too_large';

/** A local failure, raised before the request it would have made. */
export class BusinessAppError extends Error {
  readonly code: BusinessAppErrorCode;

  constructor(code: BusinessAppErrorCode, message: string) {
    super(message);
    this.name = 'BusinessAppError';
    this.code = code;
  }
}

export const THUMBNAIL_REQUIRED_MESSAGE =
  'A thumbnail is required to publish a release. Add a thumbnail image to the app.';

export interface BusinessAppsApi {
  listApps(search?: string): Promise<BusinessAppRow[]>;
  getApp(apiName: string, opts?: { previewOwner?: string }): Promise<BusinessAppDetail>;
  getVersion(apiName: string, version: number | string): Promise<BusinessAppDefinition>;
  getPreview(apiName: string, ownerId: string): Promise<BusinessAppDefinition>;
  publish(body: BusinessAppPublishBody): Promise<PublishResult>;
  promotePreview(apiName: string, ownerId: string): Promise<PromoteResult>;
  deletePreview(apiName: string, ownerId: string): Promise<void>;
  /** Uploads through a presigned S3 POST and confirms it; resolves to the Kizen file id. */
  uploadFile(bytes: Uint8Array, opts: UploadFileOptions): Promise<string>;
  downloadFile(id: string): Promise<Uint8Array>;
  /** The install's JS action ↔ object links; `appApiName` is the suffixed api_name. */
  listActionAssociations(appApiName: string): Promise<ActionAssociation[]>;
  /** Creates a link (the flat endpoint the Kizen UI uses); the server answers with no id. */
  createActionAssociation(input: CreateActionAssociationInput): Promise<void>;
  updateActionAssociation(
    appApiName: string,
    associationId: string,
    includePerformAction: boolean,
  ): Promise<void>;
  deleteActionAssociation(associationId: string): Promise<void>;
  /** Every object the signed-in user can see, Contacts included. */
  listObjects(): Promise<BusinessObject[]>;
}

const segment = encodeURIComponent;

/** Placeholder copy. */
export const BUSINESS_APPS_UNAVAILABLE_MESSAGE =
  "Business Apps aren't available on this Kizen environment yet.";

/** Placeholder copy. */
export const BUSINESS_APPS_UNAVAILABLE_HINT =
  'Kizen has no Business Apps list on this environment (it answered 404). Use an environment where Business Apps are available, with --env.';

const isNotFound = (error: unknown): error is KizenApiError =>
  error instanceof KizenApiError && error.kind === 'not_found';

/** The list endpoint's 404, as a failure that says Business Apps aren't on this environment. */
const businessAppsUnavailable = (error: KizenApiError): KizenApiError =>
  new KizenApiError('not_found', BUSINESS_APPS_UNAVAILABLE_MESSAGE, {
    ...(error.status !== undefined && { status: error.status }),
    hint: BUSINESS_APPS_UNAVAILABLE_HINT,
    details: error.details,
    cause: error,
  });

const unexpectedShape = (method: string, path: string): KizenApiError =>
  new KizenApiError('api_error', `${method} ${path} returned an unexpected response shape`);

function expectRecord(method: string, path: string, data: unknown): Record<string, unknown> {
  if (!isRecord(data)) {
    throw unexpectedShape(method, path);
  }

  return data;
}

const hasStrings = (data: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.every((key) => typeof data[key] === 'string');

interface PresignedPost {
  url: string;
  fields: Record<string, string>;
  key: string;
  s3objectId: string;
  maxFileSize: number;
}

function parsePresignedPost(path: string, data: unknown): PresignedPost {
  const root = expectRecord('GET', path, data);
  const { url, fields, s3object_id: s3objectId, max_file_size: maxFileSize } = root;

  if (
    typeof url !== 'string' ||
    !isRecord(fields) ||
    !Object.values(fields).every((value) => typeof value === 'string') ||
    typeof fields.key !== 'string' ||
    typeof s3objectId !== 'string' ||
    typeof maxFileSize !== 'number'
  ) {
    throw unexpectedShape('GET', path);
  }

  return {
    url,
    fields: fields as Record<string, string>,
    key: fields.key,
    s3objectId,
    maxFileSize,
  };
}

const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

function parseAssociation(item: unknown): ActionAssociation | null {
  if (!isRecord(item) || typeof item.id !== 'string') {
    return null;
  }

  const template = item.browser_js_action_template;
  const object = item.custom_object;
  const flag = item.include_perform_action;

  if (
    !isRecord(template) ||
    typeof template.api_name !== 'string' ||
    !isRecord(object) ||
    typeof object.id !== 'string' ||
    (flag !== null && flag !== undefined && typeof flag !== 'boolean')
  ) {
    return null;
  }

  const objectName = optionalText(object.object_name);
  const entityName = optionalText(object.entity_name);

  return {
    id: item.id,
    include_perform_action: flag ?? null,
    browser_js_action_template: {
      id: optionalText(template.id) ?? '',
      api_name: template.api_name,
      name: optionalText(template.name) ?? template.api_name,
      hint_object_name: optionalText(template.hint_object_name) ?? null,
    },
    custom_object: {
      id: object.id,
      name: optionalText(object.name) ?? '',
      ...(objectName === undefined ? {} : { object_name: objectName }),
      ...(entityName === undefined ? {} : { entity_name: entityName }),
    },
  };
}

export function createBusinessAppsApi(
  client: KizenClient,
  businessId: string,
  deps: { fetch?: typeof fetch } = {},
): BusinessAppsApi {
  // Plain fetch, for the S3 host: it must never carry Kizen credentials.
  const plainFetch = deps.fetch ?? fetch;
  const base = `/external-integrations/plugin-apps/${segment(businessId)}`;
  const appPath = (apiName: string): string => `${base}/${segment(apiName)}`;
  const previewPath = (apiName: string, ownerId: string): string =>
    `${appPath(apiName)}/previews/${segment(ownerId)}`;
  // The install's routes take the suffixed api_name; one install serves Live and every preview.
  const associationsPath = (appApiName: string): string =>
    `/external-integrations/business-plugin-apps/${segment(appApiName)}/browser-js-action-template-associations`;
  const flatAssociationPath = '/external-integrations/browser-js-action-template-association';

  const getDefinition = async (path: string): Promise<BusinessAppDefinition> =>
    expectRecord('GET', path, await client.requestJson('GET', path)) as BusinessAppDefinition;

  const uploadToS3 = async (
    presigned: PresignedPost,
    bytes: Uint8Array,
    contentType: string,
    filename: string,
  ): Promise<string> => {
    const form = new FormData();

    for (const [key, value] of Object.entries(presigned.fields)) {
      form.append(key, value);
    }

    // S3 ignores every field after `file`, so it goes last.
    form.append(
      'file',
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType }),
      filename,
    );

    let res: Response;

    try {
      res = await plainFetch(presigned.url, { method: 'POST', body: form });
    } catch (err) {
      throw new KizenApiError(
        'network_error',
        `Couldn't upload ${filename} to file storage: ${errorCause(err)}`,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];

      throw new KizenApiError(
        'api_error',
        `Uploading ${filename} to file storage failed with ${String(res.status)}${code === undefined ? '' : `: ${code}`}`,
        { status: res.status, details: text === '' ? undefined : text },
      );
    }

    await res.body?.cancel().catch(() => undefined);

    return res.headers.get('etag') ?? '';
  };

  return {
    async listApps(search?: string) {
      const query =
        search === undefined || search === ''
          ? ''
          : `?${new URLSearchParams({ search }).toString()}`;
      const path = `${base}/apps${query}`;
      let data: unknown;

      try {
        data = await client.requestJson('GET', path);
      } catch (error) {
        // The list itself never answers 404 (webapp `list_apps` returns an empty list when nothing
        // matches), so a 404 means this environment has no such endpoint.
        throw isNotFound(error) ? businessAppsUnavailable(error) : error;
      }

      if (!Array.isArray(data) || !data.every(isRecord)) {
        throw unexpectedShape('GET', path);
      }

      return data as unknown as BusinessAppRow[];
    },

    async getApp(apiName, opts = {}) {
      const query =
        opts.previewOwner === undefined
          ? ''
          : `?${new URLSearchParams({ preview_owner: opts.previewOwner }).toString()}`;
      const path = `${appPath(apiName)}${query}`;

      return expectRecord('GET', path, await client.requestJson('GET', path)) as BusinessAppDetail;
    },

    async getVersion(apiName, version) {
      return getDefinition(`${appPath(apiName)}/versions/${segment(String(version))}`);
    },

    async getPreview(apiName, ownerId) {
      return getDefinition(previewPath(apiName, ownerId));
    },

    async publish(body) {
      // The server rejects this too, but only after the uploads; fail before any request.
      if (body.release && !body.thumbnail) {
        throw new BusinessAppError('thumbnail_required', THUMBNAIL_REQUIRED_MESSAGE);
      }

      const path = `${base}/publish`;
      const data = expectRecord('POST', path, await client.requestJson('POST', path, body));

      if (!hasStrings(data, ['api_name', 'base_api_name', 'version'])) {
        throw unexpectedShape('POST', path);
      }

      return data as unknown as PublishResult;
    },

    async promotePreview(apiName, ownerId) {
      const path = `${previewPath(apiName, ownerId)}/promote`;
      const data = expectRecord('POST', path, await client.requestJson('POST', path));

      if (!hasStrings(data, ['api_name', 'version'])) {
        throw unexpectedShape('POST', path);
      }

      return data as unknown as PromoteResult;
    },

    async deletePreview(apiName, ownerId) {
      await client.requestJson('DELETE', previewPath(apiName, ownerId));
    },

    async uploadFile(bytes, opts) {
      const params = new URLSearchParams({
        filename: opts.filename,
        contenttype: opts.contentType,
        source: opts.source,
      });
      const presignPath = `/s3/presigned-post?${params.toString()}`;
      const presigned = parsePresignedPost(
        presignPath,
        await client.requestJson('GET', presignPath),
      );

      if (bytes.byteLength > presigned.maxFileSize) {
        throw new BusinessAppError(
          'file_too_large',
          `${opts.filename} is ${String(bytes.byteLength)} bytes; the limit is ${String(presigned.maxFileSize)} bytes.`,
        );
      }

      const etag = await uploadToS3(presigned, bytes, opts.contentType, opts.filename);
      const successPath = `/s3/success?${new URLSearchParams({ source: opts.source }).toString()}`;
      const fields: Record<string, string> = {
        uuid: presigned.s3objectId,
        key: presigned.key,
        name: opts.filename,
        etag,
      };

      if (opts.isPublic === true) {
        fields.is_public = 'true';
      }

      const confirmed = expectRecord(
        'POST',
        successPath,
        await client.postForm(successPath, fields),
      );

      if (typeof confirmed.id !== 'string') {
        throw unexpectedShape('POST', successPath);
      }

      return confirmed.id;
    },

    async downloadFile(id) {
      return client.getBinary(`/files/${segment(id)}/download`);
    },

    async listActionAssociations(appApiName) {
      const path = associationsPath(appApiName);
      const data = expectRecord('GET', path, await client.requestJson('GET', path));

      if (!Array.isArray(data.associations)) {
        throw unexpectedShape('GET', path);
      }

      return data.associations.map((item) => {
        const parsed = parseAssociation(item);

        if (parsed === null) {
          throw unexpectedShape('GET', path);
        }

        return parsed;
      });
    },

    async createActionAssociation(input) {
      await client.requestJson('POST', flatAssociationPath, {
        browser_js_action_template: {
          api_name: input.actionApiName,
          plugin_app_api_name: input.appApiName,
        },
        custom_object: { id: input.objectId },
        include_perform_action: input.includePerformAction,
      });
    },

    async updateActionAssociation(appApiName, associationId, includePerformAction) {
      await client.requestJson(
        'PATCH',
        `${associationsPath(appApiName)}/${segment(associationId)}`,
        { include_perform_action: includePerformAction },
      );
    },

    async deleteActionAssociation(associationId) {
      await client.requestJson('DELETE', `${flatAssociationPath}/${segment(associationId)}`);
    },

    async listObjects() {
      const objects = await client.listCustomObjects({ customOnly: false });

      return objects.map((object) => ({
        id: object.id,
        name: object.name ?? '',
        objectName: object.object_name,
        entityName: object.entity_name ?? null,
      }));
    },
  };
}
