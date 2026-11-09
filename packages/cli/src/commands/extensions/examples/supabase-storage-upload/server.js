/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { uploadFile } from './upload.js';

const server = new McpServer({
  name: 'supabase-storage-upload',
  version: '1.0.0',
});

server.registerTool(
  'upload_file_to_supabase_storage',
  {
    description:
      'Upload a user-selected local file to the configured Supabase Storage bucket using resumable TUS uploads. The user JWT must be allowed to insert into the bucket. Only call this when the user asks to upload the file.',
    inputSchema: z.object({
      filePath: z
        .string()
        .min(1)
        .describe('Absolute local path of the file the user asked to upload.'),
      objectPath: z
        .string()
        .optional()
        .describe(
          'Optional destination object path in the bucket. Defaults to the local file name.',
        ),
    }).shape,
  },
  async ({ filePath, objectPath }) => {
    try {
      const result = await uploadFile({
        filePath,
        objectPath,
        projectUrl: process.env.SUPABASE_URL,
        publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
        bucket: process.env.SUPABASE_STORAGE_BUCKET,
        bearerToken: process.env.SUPABASE_BEARER_TOKEN,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Uploaded ${result.objectPath} to bucket ${result.bucket} (${result.size} bytes).`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : 'Upload failed.',
          },
        ],
      };
    }
  },
);

await server.connect(new StdioServerTransport());
