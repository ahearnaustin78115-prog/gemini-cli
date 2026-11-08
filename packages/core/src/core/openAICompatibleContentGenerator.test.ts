/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import { Type } from '@google/genai';
import { OpenAICompatibleContentGenerator } from './openAICompatibleContentGenerator.js';

const request: GenerateContentParameters = {
  model: 'test-model',
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  config: {
    tools: [
      {
        functionDeclarations: [
          {
            name: 'lookup',
            description: 'Look up a value',
            parameters: {
              type: Type.OBJECT,
              properties: { key: { type: Type.STRING } },
            },
          },
        ],
      },
    ],
  },
};

describe('OpenAICompatibleContentGenerator', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('converts chat requests and tool calls to the OpenAI chat completions format', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"key":"value"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const generator = new OpenAICompatibleContentGenerator(
      'test-key',
      'http://localhost:8000/v1',
      'test-model',
    );

    const result = await generator.generateContent(request);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://localhost:8000/v1/chat/completions'),
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          Authorization: ['Bearer ', 'test-key'].join(''),
        },
        body: expect.stringContaining('"model":"test-model"'),
      }),
    );
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') {
      throw new Error('Expected request body to be a JSON string.');
    }
    const sentBody: unknown = JSON.parse(body);
    if (
      typeof sentBody !== 'object' ||
      sentBody === null ||
      !('messages' in sentBody) ||
      !('tools' in sentBody)
    ) {
      throw new Error('Expected OpenAI chat completion request.');
    }
    expect(sentBody.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(sentBody.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          function: expect.objectContaining({ name: 'lookup' }),
        }),
      ]),
    );
    expect(result.candidates?.[0]?.content?.parts?.[0]?.functionCall).toEqual({
      id: 'call-1',
      name: 'lookup',
      args: { key: 'value' },
    });
    expect(result.usageMetadata?.totalTokenCount).toBe(6);
  });

  it('streams text and assembles streamed tool calls', async () => {
    const stream = [
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );
    const generator = new OpenAICompatibleContentGenerator(
      undefined,
      'http://localhost:8000/v1',
      'test-model',
    );
    const chunks: GenerateContentResponse[] = [];
    for await (const chunk of await generator.generateContentStream(request)) {
      chunks.push(chunk);
    }

    expect(chunks[0]?.candidates?.[0]?.content?.parts?.[0]?.text).toBe('hi');
    expect(
      chunks.at(-1)?.candidates?.[0]?.content?.parts?.[0]?.functionCall,
    ).toMatchObject({
      id: 'call-1',
      name: 'lookup',
      args: {},
    });
  });
});
