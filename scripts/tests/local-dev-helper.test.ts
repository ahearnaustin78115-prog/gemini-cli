/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(
  new URL('../local-dev-helper.sh', import.meta.url),
);

describe('local-dev-helper Android commands', () => {
  let testDir: string;
  let callsPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'local-dev-helper-'));
    const binDir = join(testDir, 'bin');
    mkdirSync(binDir);
    callsPath = join(testDir, 'adb-calls.log');

    const adbPath = join(binDir, 'adb');
    writeFileSync(
      adbPath,
      `#!/usr/bin/env bash
printf 'adb' >>"$ADB_CALL_LOG"
printf ' <%s>' "$@" >>"$ADB_CALL_LOG"
printf '\\n' >>"$ADB_CALL_LOG"
printf 'adb'
printf ' <%s>' "$@"
printf '\\n'
`,
    );
    chmodSync(adbPath, 0o755);

    env = {
      ...process.env,
      PATH: [binDir, process.env.PATH].filter(Boolean).join(delimiter),
      ADB_CALL_LOG: callsPath,
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function runHelper(...args: string[]) {
    return spawnSync('bash', [helperPath, ...args], {
      cwd: testDir,
      env,
      encoding: 'utf8',
    });
  }

  function expectAdbCalls(expected: string) {
    expect(readFileSync(callsPath, 'utf8')).toBe(expected);
  }

  it('diagnoses the ADB version, server, and connected devices', () => {
    const result = runHelper('android', 'diagnose');

    expect(result.status).toBe(0);
    expectAdbCalls('adb <version>\nadb <server-status>\nadb <devices> <-l>\n');
  });

  it('lists devices with long descriptions', () => {
    const result = runHelper('android', 'devices');

    expect(result.status).toBe(0);
    expectAdbCalls('adb <devices> <-l>\n');
  });

  it('forwards Wi-Fi pairing and connection operations', () => {
    expect(runHelper('android', 'pair', '192.168.1.10:37123').status).toBe(0);
    expect(runHelper('android', 'connect', '192.168.1.10:5555').status).toBe(0);
    expect(runHelper('android', 'disconnect', '192.168.1.10:5555').status).toBe(
      0,
    );
    expect(runHelper('android', 'disconnect').status).toBe(0);

    expectAdbCalls(
      'adb <pair> <192.168.1.10:37123>\n' +
        'adb <connect> <192.168.1.10:5555>\n' +
        'adb <disconnect> <192.168.1.10:5555>\n' +
        'adb <disconnect>\n',
    );
  });

  it('validates device addresses before invoking adb', () => {
    for (const address of [
      'missing-port',
      'host:abc',
      'host:0',
      'host:65536',
      ':5555',
      'host name:5555',
    ]) {
      const result = runHelper('android', 'connect', address);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Error:');
    }

    expect(existsSync(callsPath)).toBe(false);
  });

  it('restarts the host ADB server', () => {
    const result = runHelper('android', 'restart-server');

    expect(result.status).toBe(0);
    expectAdbCalls('adb <kill-server>\nadb <start-server>\n');
  });

  it('installs an existing APK and rejects missing or non-APK files', () => {
    const apkPath = join(testDir, 'debug build.APK');
    writeFileSync(apkPath, 'test apk');

    expect(runHelper('android', 'install', apkPath).status).toBe(0);
    expect(
      runHelper('android', 'install', join(testDir, 'missing.apk')).status,
    ).not.toBe(0);
    expect(runHelper('android', 'install', 'package.deb').status).not.toBe(0);

    expectAdbCalls(`adb <install> <${apkPath}>\n`);
  });
});
