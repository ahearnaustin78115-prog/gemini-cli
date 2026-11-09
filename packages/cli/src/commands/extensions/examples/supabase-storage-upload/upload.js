/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { open, stat } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CHUNK_SIZE = 6 * 1024 * 1024;
const MAX_RETRIES = 3;
const activeUploads = new Map();

function requireSetting(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Configure ${name} in the extension settings.`);
  }
  return value;
}

function getProjectUrl(value) {
  let url;
  try {
    url = new URL(requireSetting(value, 'SUPABASE_URL'));
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('SUPABASE_URL must be a valid HTTP or HTTPS URL.');
    }
    throw error;
  }

  const isLocalHttp =
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !isLocalHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'SUPABASE_URL must use HTTPS (HTTP is allowed for localhost) and must not include credentials, query, or fragment.',
    );
  }

  return url;
}

function encodeMetadata(metadata) {
  return Object.entries(metadata)
    .map(
      ([key, value]) =>
        `${key} ${Buffer.from(String(value), 'utf8').toString('base64')}`,
    )
    .join(',');
}

function parseOffset(response, fileSize) {
  const rawOffset = response.headers.get('Upload-Offset');
  if (!rawOffset || !/^\d+$/.test(rawOffset)) {
    throw new Error('Supabase returned an invalid TUS upload offset.');
  }

  const offset = Number(rawOffset);
  if (!Number.isSafeInteger(offset) || offset > fileSize) {
    throw new Error('Supabase returned an out-of-range TUS upload offset.');
  }

  return offset;
}

function getServerError(response) {
  return response
    .text()
    .then((text) => text.slice(0, 500))
    .catch(() => '');
}

function assertUploadUrl(location, endpoint) {
  const uploadUrl = new URL(location, endpoint);
  if (
    uploadUrl.origin !== endpoint.origin ||
    uploadUrl.protocol !== endpoint.protocol
  ) {
    throw new Error('Supabase returned an upload URL on a different origin.');
  }
  return uploadUrl;
}

async function createUpload({
  endpoint,
  headers,
  fileSize,
  bucket,
  objectPath,
  contentType,
  fetchImpl,
}) {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      ...headers,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(fileSize),
      'Upload-Metadata': encodeMetadata({
        bucketName: bucket,
        objectName: objectPath,
        contentType,
      }),
    },
    redirect: 'error',
  });

  if (response.status !== 201) {
    const details = await getServerError(response);
    throw new Error(
      `Could not start the Supabase upload (HTTP ${response.status})${details ? `: ${details}` : ''}`,
    );
  }

  const location = response.headers.get('Location');
  if (!location) {
    throw new Error('Supabase did not return a TUS upload location.');
  }

  return assertUploadUrl(location, endpoint);
}

async function getUploadOffset(uploadUrl, headers, fileSize, fetchImpl) {
  const response = await fetchImpl(uploadUrl, {
    method: 'HEAD',
    headers: { ...headers, 'Tus-Resumable': '1.0.0' },
    redirect: 'error',
  });

  if (!response.ok) {
    throw new Error(
      `Could not resume the Supabase upload (HTTP ${response.status}).`,
    );
  }

  return parseOffset(response, fileSize);
}

function waitBeforeRetry(attempt) {
  return new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
}

async function sendChunk({
  uploadUrl,
  headers,
  offset,
  chunk,
  fileSize,
  fetchImpl,
}) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response;
    try {
      response = await fetchImpl(uploadUrl, {
        method: 'PATCH',
        headers: {
          ...headers,
          'Tus-Resumable': '1.0.0',
          'Upload-Offset': String(offset),
          'Content-Type': 'application/offset+octet-stream',
        },
        body: chunk,
        redirect: 'error',
      });
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(
          'The Supabase upload could not be resumed after several retries.',
          {
            cause: error,
          },
        );
      }
    }

    if (response?.ok) {
      const nextOffset = parseOffset(response, fileSize);
      if (nextOffset !== offset + chunk.length) {
        throw new Error('Supabase returned an unexpected TUS upload offset.');
      }
      return nextOffset;
    }

    if (response && response.status < 500 && response.status !== 409) {
      const details = await getServerError(response);
      throw new Error(
        `Supabase rejected the upload chunk (HTTP ${response.status})${details ? `: ${details}` : ''}`,
      );
    }

    await response?.body?.cancel();

    if (attempt === MAX_RETRIES) {
      throw new Error(
        'The Supabase upload could not be resumed after several retries.',
      );
    }

    await waitBeforeRetry(attempt);
    const nextOffset = await getUploadOffset(
      uploadUrl,
      headers,
      fileSize,
      fetchImpl,
    );
    if (nextOffset !== offset) {
      return nextOffset;
    }
  }

  throw new Error('The Supabase upload could not be resumed.');
}

export async function uploadFile({
  filePath,
  objectPath,
  projectUrl,
  publishableKey,
  bucket,
  bearerToken,
  chunkSize = DEFAULT_CHUNK_SIZE,
  fetchImpl = fetch,
}) {
  const resolvedPath = path.resolve(requireSetting(filePath, 'filePath'));
  const fileInfo = await stat(resolvedPath);
  if (!fileInfo.isFile()) {
    throw new Error('filePath must refer to a regular file.');
  }
  if (fileInfo.size === 0) {
    throw new Error(
      'Empty files cannot be uploaded with resumable TUS uploads.',
    );
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error('chunkSize must be a positive safe integer.');
  }

  const project = getProjectUrl(projectUrl);
  const publishable = requireSetting(
    publishableKey,
    'SUPABASE_PUBLISHABLE_KEY',
  );
  const storageBucket = requireSetting(bucket, 'SUPABASE_STORAGE_BUCKET');
  const token = requireSetting(bearerToken, 'SUPABASE_BEARER_TOKEN');
  const destinationPath = objectPath ?? path.basename(resolvedPath);
  if (
    typeof destinationPath !== 'string' ||
    destinationPath.length === 0 ||
    destinationPath.startsWith('/') ||
    destinationPath
      .split('/')
      .some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('objectPath must be a non-empty bucket-relative path.');
  }

  const endpoint = new URL('/storage/v1/upload/resumable', project);
  const headers = {
    apikey: publishable,
    authorization: 'Bearer ' + token,
  };
  const key = [
    endpoint.origin,
    storageBucket,
    destinationPath,
    resolvedPath,
    fileInfo.size,
    fileInfo.mtimeMs,
  ].join('\0');

  let activeUpload = activeUploads.get(key);
  const resumed = Boolean(activeUpload);
  if (!activeUpload) {
    const uploadUrl = await createUpload({
      endpoint,
      headers,
      fileSize: fileInfo.size,
      bucket: storageBucket,
      objectPath: destinationPath,
      contentType: 'application/octet-stream',
      fetchImpl,
    });
    activeUpload = { uploadUrl, offset: 0 };
    activeUploads.set(key, activeUpload);
  } else {
    activeUpload.offset = await getUploadOffset(
      activeUpload.uploadUrl,
      headers,
      fileInfo.size,
      fetchImpl,
    );
  }

  const fileHandle = await open(resolvedPath, 'r');
  try {
    while (activeUpload.offset < fileInfo.size) {
      const currentInfo = await fileHandle.stat();
      if (
        currentInfo.size !== fileInfo.size ||
        currentInfo.mtimeMs !== fileInfo.mtimeMs
      ) {
        throw new Error('The local file changed during the upload.');
      }

      const chunk = Buffer.alloc(
        Math.min(chunkSize, fileInfo.size - activeUpload.offset),
      );
      const { bytesRead } = await fileHandle.read(
        chunk,
        0,
        chunk.length,
        activeUpload.offset,
      );
      if (bytesRead !== chunk.length) {
        throw new Error('The local file could not be read completely.');
      }

      activeUpload.offset = await sendChunk({
        uploadUrl: activeUpload.uploadUrl,
        headers,
        offset: activeUpload.offset,
        chunk,
        fileSize: fileInfo.size,
        fetchImpl,
      });
    }
  } finally {
    await fileHandle.close();
  }

  activeUploads.delete(key);
  return {
    bucket: storageBucket,
    objectPath: destinationPath,
    size: fileInfo.size,
    resumed,
  };
}
