/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type { ContentGenerator } from './contentGenerator.js';
import { estimateTokenCountSync } from '../utils/tokenCalculation.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function contentParts(contents: unknown): JsonRecord[] {
  if (!Array.isArray(contents)) {
    return [];
  }
  const result: JsonRecord[] = [];
  for (const content of contents) {
    if (typeof content === 'string') {
      result.push({ text: content });
    } else if (isRecord(content) && Array.isArray(content['parts'])) {
      result.push(...asRecords(content['parts']));
    } else if (isRecord(content)) {
      result.push(content);
    }
  }
  return result;
}

function textFrom(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!isRecord(value)) {
    return '';
  }
  return contentParts([value]).map((part) => stringValue(part['text']) ?? '').join('');
}

function imageUrl(part: JsonRecord): string | undefined {
  const inlineData = isRecord(part['inlineData'])
    ? part['inlineData']
    : undefined;
  if (inlineData) {
    const data = stringValue(inlineData['data']);
    const mimeType = stringValue(inlineData['mimeType']);
    if (data && mimeType?.startsWith('image/')) {
      return `data:${mimeType};base64,${data}`;
    }
  }

  const fileData = isRecord(part['fileData']) ? part['fileData'] : undefined;
  const fileUri = stringValue(fileData?.['fileUri']);
  const mimeType = stringValue(fileData?.['mimeType']);
  if (fileUri && mimeType?.startsWith('image/')) {
    return fileUri;
  }
  return undefined;
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function toolDeclarations(tools: unknown): JsonRecord[] {
  const declarations = asRecords(tools).flatMap((tool) =>
    asRecords(tool['functionDeclarations']),
  );
  return declarations.flatMap((declaration) => {
    const name = stringValue(declaration['name']);
    if (!name) {
      return [];
    }
    return [
      {
        type: 'function',
        function: {
          name,
          description: stringValue(declaration['description']),
          parameters:
            declaration['parametersJsonSchema'] ??
            declaration['parameters'] ?? { type: 'object', properties: {} },
        },
      },
    ];
  });
}

function toOpenAIMessages(request: GenerateContentParameters): JsonRecord[] {
  const requestRecord = request as unknown as JsonRecord;
  const config = isRecord(requestRecord['config'])
    ? requestRecord['config']
    : {};
  const messages: JsonRecord[] = [];
  const systemText = textFrom(config['systemInstruction']);
  if (systemText) {
    messages.push({ role: 'system', content: systemText });
  }

  const toolIdsByName = new Map<string, string>();
  let generatedToolId = 0;
  const contents = requestRecord['contents'];
  if (!Array.isArray(contents)) {
    if (typeof contents === 'string') {
      messages.push({ role: 'user', content: contents });
    }
    return messages;
  }

  for (const content of contents) {
    if (typeof content === 'string') {
      messages.push({ role: 'user', content });
      continue;
    }
    if (!isRecord(content)) {
      continue;
    }
    const role = stringValue(content['role']);
    const parts = Array.isArray(content['parts'])
      ? asRecords(content['parts'])
      : [content];
    const text = parts
      .map((part) => stringValue(part['text']) ?? '')
      .filter(Boolean)
      .join('');
    const images = parts.flatMap((part) => {
      const url = imageUrl(part);
      return url
        ? [{ type: 'image_url', image_url: { url, detail: 'auto' } }]
        : [];
    });
    const calls = parts.flatMap((part) => {
      const call = isRecord(part['functionCall'])
        ? part['functionCall']
        : undefined;
      const name = stringValue(call?.['name']);
      if (!call || !name) {
        return [];
      }
      const id =
        stringValue(call['id']) ?? `call_${name}_${generatedToolId++}`;
      toolIdsByName.set(name, id);
      return [
        {
          id,
          type: 'function',
          function: {
            name,
            arguments: stringifyToolResult(call['args']),
          },
        },
      ];
    });
    const responses = parts.flatMap((part) => {
      const response = isRecord(part['functionResponse'])
        ? part['functionResponse']
        : undefined;
      const name = stringValue(response?.['name']);
      if (!response || !name) {
        return [];
      }
      const id =
        stringValue(response['id']) ?? toolIdsByName.get(name) ?? name;
      return [
        {
          role: 'tool',
          tool_call_id: id,
          content: stringifyToolResult(response['response']),
        },
      ];
    });

    if (responses.length > 0) {
      messages.push(...responses);
    }
    if (text || images.length > 0 || calls.length > 0) {
      const message: JsonRecord = {
        role: role === 'model' ? 'assistant' : role === 'system' ? 'system' : 'user',
        content:
          images.length > 0
            ? [
                ...(text ? [{ type: 'text', text }] : []),
                ...images,
              ]
            : text || null,
      };
      if (calls.length > 0) {
        message['tool_calls'] = calls;
      }
      messages.push(message);
    }
  }
  return messages;
}

function toolCallParts(calls: Map<number, JsonRecord>): JsonRecord[] {
  return [...calls.values()].flatMap((call) => {
    const fn = isRecord(call['function']) ? call['function'] : {};
    const name = stringValue(fn['name']);
    if (!name) {
      return [];
    }
    let args: unknown = {};
    const rawArgs = stringValue(fn['arguments']);
    if (rawArgs) {
      try {
        args = JSON.parse(rawArgs) as unknown;
      } catch {
        args = {};
      }
    }
    return [
      {
        functionCall: {
          id: stringValue(call['id']),
          name,
          args: isRecord(args) ? args : {},
        },
      },
    ];
  });
}

function response(
  parts: JsonRecord[],
  finishReason?: string,
  usage?: unknown,
): GenerateContentResponse {
  const usageRecord = isRecord(usage) ? usage : {};
  const candidate: JsonRecord = {
    content: { role: 'model', parts },
    finishReason:
      finishReason === 'length'
        ? 'MAX_TOKENS'
        : finishReason === 'tool_calls' || finishReason === 'stop'
          ? 'STOP'
          : 'OTHER',
  };
  const responseRecord: JsonRecord = {
    candidates: [candidate],
    ...(typeof usageRecord['prompt_tokens'] === 'number' ||
    typeof usageRecord['completion_tokens'] === 'number'
      ? {
          usageMetadata: {
            promptTokenCount: usageRecord['prompt_tokens'],
            candidatesTokenCount: usageRecord['completion_tokens'],
            totalTokenCount: usageRecord['total_tokens'],
          },
        }
      : {}),
  };
  // The provider response is converted to the Google GenAI shape consumed by GeminiChat.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return responseRecord as GenerateContentResponse;
}

export class OpenAICompatibleContentGenerator implements ContentGenerator {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  async generateContent(
    request: GenerateContentParameters,
  ): Promise<GenerateContentResponse> {
    const result = await this.request(request, false);
    const payload: unknown = await result.json();
    if (!isRecord(payload)) {
      throw new Error('OpenAI-compatible endpoint returned an invalid response.');
    }
    const choices = asRecords(payload['choices']);
    const choice = choices[0];
    const message = isRecord(choice?.['message']) ? choice['message'] : {};
    const parts: JsonRecord[] = [];
    const text = stringValue(message['content']);
    if (text) {
      parts.push({ text });
    }
    const calls = new Map<number, JsonRecord>();
    asRecords(message['tool_calls']).forEach((call, index) => {
      calls.set(index, call);
    });
    parts.push(...toolCallParts(calls));
    if (parts.length === 0) {
      parts.push({ text: '' });
    }
    return response(
      parts,
      stringValue(choice?.['finish_reason']),
      payload['usage'],
    );
  }

  async generateContentStream(
    request: GenerateContentParameters,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const result = await this.request(request, true);
    if (!result.body) {
      throw new Error('OpenAI-compatible endpoint did not return a response stream.');
    }
    return this.readStream(result.body);
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    const record = request as unknown as JsonRecord;
    const tokens = estimateTokenCountSync(contentParts(record['contents']));
    return { totalTokens: tokens };
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error(
      'Embedding is not supported by the OpenAI-compatible chat provider.',
    );
  }

  private async request(
    request: GenerateContentParameters,
    stream: boolean,
  ): Promise<Response> {
    const url = new URL(this.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('OpenAI-compatible base URL must use HTTP or HTTPS.');
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `******;
    }

    const record = request as unknown as JsonRecord;
    const config = isRecord(record['config']) ? record['config'] : {};
    const body: JsonRecord = {
      model: this.model,
      messages: toOpenAIMessages(request),
      stream,
    };
    const generationConfig = isRecord(config['generationConfig'])
      ? config['generationConfig']
      : config;
    for (const [source, target] of [
      ['temperature', 'temperature'],
      ['topP', 'top_p'],
      ['maxOutputTokens', 'max_tokens'],
      ['stopSequences', 'stop'],
    ]) {
      if (generationConfig[source] !== undefined) {
        body[target] = generationConfig[source];
      }
    }
    const tools = toolDeclarations(config['tools']);
    if (tools.length > 0) {
      body['tools'] = tools;
    }

    const result = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!result.ok) {
      const detail = await result.text();
      throw new Error(
        `OpenAI-compatible request failed (${result.status}): ${detail}`,
      );
    }
    return result;
  }

  private async *readStream(
    stream: ReadableStream<Uint8Array>,
  ): AsyncGenerator<GenerateContentResponse> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const calls = new Map<number, JsonRecord>();
    let buffer = '';
    let finishReason: string | undefined;
    let usage: unknown;

    const processEvent = (data: string): GenerateContentResponse | undefined => {
      if (!data || data === '[DONE]') {
        return undefined;
      }
      const event: unknown = JSON.parse(data);
      if (!isRecord(event)) {
        return undefined;
      }
      if (event['usage']) {
        usage = event['usage'];
      }
      const choice = asRecords(event['choices'])[0];
      if (!choice) {
        return undefined;
      }
      finishReason = stringValue(choice['finish_reason']) ?? finishReason;
      const delta = isRecord(choice['delta']) ? choice['delta'] : {};
      const parts: JsonRecord[] = [];
      const text = stringValue(delta['content']);
      if (text) {
        parts.push({ text });
      }
      for (const tool of asRecords(delta['tool_calls'])) {
        const index =
          typeof tool['index'] === 'number' ? tool['index'] : calls.size;
        const current = calls.get(index) ?? { function: {} };
        const fn = isRecord(current['function']) ? current['function'] : {};
        const deltaFn = isRecord(tool['function']) ? tool['function'] : {};
        const id = stringValue(tool['id']) ?? stringValue(current['id']);
        const name = stringValue(deltaFn['name']);
        const args =
          (stringValue(fn['arguments']) ?? '') +
          (stringValue(deltaFn['arguments']) ?? '');
        calls.set(index, {
          ...current,
          ...(id ? { id } : {}),
          function: {
            ...fn,
            ...(name ? { name } : {}),
            arguments: args,
          },
        });
      }
      return parts.length > 0 ? response(parts) : undefined;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) {
            continue;
          }
          const parsed = processEvent(line.slice(5).trim());
          if (parsed) {
            yield parsed;
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.startsWith('data:')) {
        const parsed = processEvent(buffer.slice(5).trim());
        if (parsed) {
          yield parsed;
        }
      }
      yield response(toolCallParts(calls), finishReason, usage);
    } finally {
      reader.releaseLock();
    }
  }
}
