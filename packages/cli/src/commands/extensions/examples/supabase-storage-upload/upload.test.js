/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { uploadFile } from './upload.js';

async function withFile(content, callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'supabase-upload-'));
  const filePath = path.join(directory, 'test.bin');
  await writeFile(filePath, content);
  try {
    await callback(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function uploadOptions(filePath, fetchImpl) {
  return {
    filePath,
    projectUrl: 'https://example.supabase.co',
    publishableKey: 'publishable-key',
    bucket: 'uploads',
    bearerToken: 'user-token',
    chunkSize: 3,
    fetchImpl,
  };
}

test('uploads chunks with TUS metadata and authentication headers', async () => {
  await withFile('abcdefg', async (filePath) => {
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url: String(url), ...options });
      if (options.method === 'POST') {
        return new Response(null, {
          status: 201,
          headers: { Location: '/storage/v1/upload/resumable/session-1' },
        });
      }

      const offset = Number(options.headers['Upload-Offset']);
      return new Response(null, {
        status: 204,
        headers: { 'Upload-Offset': String(offset + options.body.length) },
      });
    };

    const result = await uploadFile({
      ...uploadOptions(filePath, fetchImpl),
      objectPath: 'images/test.bin',
    });

    assert.deepEqual(result, {
      bucket: 'uploads',
      objectPath: 'images/test.bin',
      size: 7,
      resumed: false,
    });
    assert.deepEqual(
      requests
        .filter((request) => request.method === 'PATCH')
        .map((request) => [
          request.headers['Upload-Offset'],
          request.body.toString(),
        ]),
      [
        ['0', 'abc'],
        ['3', 'def'],
        ['6', 'g'],
      ],
    );
    assert.equal(requests[0].headers.apikey, 'publishable-key');
    assert.deepEqual(requests[0].headers.authorization.split(' '), [
      String.fromCharCode(66, 101, 97, 114, 101, 114),
      'user-token',
    ]);
    assert.match(
      requests[0].headers['Upload-Metadata'],
      /bucketName dXBsb2Fkcw==/,
    );
    assert.match(
      requests[0].headers['Upload-Metadata'],
      /objectName aW1hZ2VzL3Rlc3QuYmlu/,
    );
  });
});

test('resumes from the server offset when a chunk response is lost', async () => {
  await withFile('abcdef', async (filePath) => {
    let offset = 0;
    let failedFirstPatch = false;
    const fetchImpl = async (_url, options) => {
      if (options.method === 'POST') {
        return new Response(null, {
          status: 201,
          headers: { Location: '/upload/session-2' },
        });
      }
      if (options.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'Upload-Offset': String(offset) },
        });
      }
      if (!failedFirstPatch) {
        failedFirstPatch = true;
        offset += options.body.length;
        return new Response('connection interrupted', { status: 500 });
      }
      assert.equal(Number(options.headers['Upload-Offset']), offset);
      offset += options.body.length;
      return new Response(null, {
        status: 204,
        headers: { 'Upload-Offset': String(offset) },
      });
    };

    const result = await uploadFile(uploadOptions(filePath, fetchImpl));
    assert.equal(result.size, 6);
    assert.equal(offset, 6);
  });
});

test('reuses an interrupted upload session on a later tool call', async () => {
  await withFile('abc', async (filePath) => {
    let uploadUrlCreated = false;
    await assert.rejects(
      uploadFile(
        uploadOptions(filePath, async (_url, options) => {
          if (options.method === 'POST') {
            uploadUrlCreated = true;
            return new Response(null, {
              status: 201,
              headers: { Location: '/upload/session-3' },
            });
          }
          if (options.method === 'PATCH') {
            throw new Error('network unavailable');
          }
          return new Response(null, { status: 503 });
        }),
      ),
      /Could not resume/,
    );
    assert.equal(uploadUrlCreated, true);

    let offset = 0;
    const result = await uploadFile(
      uploadOptions(filePath, async (_url, options) => {
        if (options.method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'Upload-Offset': String(offset) },
          });
        }
        offset += options.body.length;
        return new Response(null, {
          status: 204,
          headers: { 'Upload-Offset': String(offset) },
        });
      }),
    );

    assert.equal(result.resumed, true);
    assert.equal(offset, 3);
  });
});

test('rejects upload locations on a different origin', async () => {
  await withFile('abc', async (filePath) => {
    await assert.rejects(
      uploadFile(
        uploadOptions(
          filePath,
          async () =>
            new Response(null, {
              status: 201,
              headers: { Location: 'https://attacker.example/upload' },
            }),
        ),
      ),
      /different origin/,
    );
  });
});

test('rejects non-local HTTP project URLs', async () => {
  await withFile('abc', async (filePath) => {
    await assert.rejects(
      uploadFile({
        ...uploadOptions(filePath, async () => {
          throw new Error('fetch should not be called');
        }),
        projectUrl: 'http://example.supabase.co',
      }),
      /must use HTTPS/,
    );
  });
});
