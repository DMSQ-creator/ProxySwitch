'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../js/configuration.js');
const server = { id: 'main', name: 'Local proxy', scheme: 'SOCKS5', host: '127.0.0.1', port: 7890 };

test('rules normalize IDN and case, deduplicate and preserve leading-dot semantics', () => {
  assert.deepEqual(config.validateRules([' EXAMPLE.com ', 'example.com', '例子.测试', '*.例子.测试', '.Example.com']),
    ['example.com', 'xn--fsqu00a.xn--0zwm56d', '*.xn--fsqu00a.xn--0zwm56d', '.example.com']);
});

test('invalid rule entries reject the entire import without exposing content', () => {
  for (const value of [123, null, {}, '', 'https://example.com/private?token=secret', 'bad domain', 'example..com', 'example.com/path', '-bad.example', 'example.com:80', 'foo?bar.example']) {
    assert.throws(() => config.validateRules(['valid.example', value]), error => error.code === 'invalid_rules' && error.index === 1 && error.message === 'invalid_rules');
  }
  assert.throws(() => config.validateRules('example.com'), /invalid_rules/);
  assert.throws(() => config.validateRules(['*.example.com'], { allowWildcards: false }), /invalid_rules/);
});

test('cloud restore accepts empty core arrays and removes non-core fields', () => {
  const backup = { backupVer: 5, userRules: [], userWhitelist: [], serverList: [], activeServerId: '', gfwlistUrl: '', tempRules: ['session.example'],
    gitToken: 'secret', theme: 'dark', diagnosticTrial: {}, diagnosticRuleUndo: { hosts: ['private.example'], afterDigest: 'private' },
    diagnosticUiState: { pendingMutation: { actionId: 'private' } }, diagnosticAutoCapture: true,
    diagnosticAutoRecords: { records: [{ hostname: 'private.example' }] }, autoSync: true, cloudRestoreUndo: {}, __psl_log_generation_v2: 'forged' };
  assert.deepEqual(config.validateBackup(backup), { userRules: [], userWhitelist: [], serverList: [], activeServerId: '', gfwlistUrl: '' });
  assert.equal(backup.gitToken, 'secret', 'validation must not mutate input');
});

test('recognized old backup versions share the safe current core schema', () => {
  for (const backupVer of [1, 2, 3, 4, 5]) assert.deepEqual(config.validateBackup({ backupVer, userRules: ['EXAMPLE.com'] }), { userRules: ['example.com'] });
  for (const backupVer of [undefined, null, 0, 6, '5', 2.5]) {
    const remote = backupVer === undefined ? { userRules: [] } : { backupVer, userRules: [] };
    assert.throws(() => config.validateBackup(remote), error => error.code === 'unsupported_backup_version');
  }
});

test('backup validation rejects malformed types, servers and references atomically', () => {
  for (const remote of [[], null, { backupVer: 5 }, { backupVer: 5, userRules: [1] }, { backupVer: 5, userWhitelist: ['*.example.com'] },
    { backupVer: 5, userRules: null }, { backupVer: 5, serverList: 'bad' }, { backupVer: 5, gfwlistUrl: 'javascript:alert(1)' },
    { backupVer: 5, gfwlistUrl: 'https://user:pass@example.com/file' }, { backupVer: 5, serverList: [server, server] },
    { backupVer: 5, serverList: [server], activeServerId: 'missing' }]) assert.throws(() => config.validateBackup(remote));
  assert.deepEqual(config.validateBackup({ backupVer: 5, serverList: [server] }), { serverList: [server], activeServerId: 'main' });
});

test('server validation is strict, normalized and strips unknown fields', () => {
  assert.deepEqual(config.validateServer({ ...server, name: '<b>not HTML</b>', host: '例子.测试', scheme: 'https', token: 'discarded' }),
    { id: 'main', name: '<b>not HTML</b>', scheme: 'HTTPS', host: 'xn--fsqu00a.xn--0zwm56d', port: 7890 });
  assert.equal(config.validateServer({ ...server, host: '[::1]' }).host, '[::1]');
  for (const change of [{ id: '' }, { name: '' }, { host: 'evil.example/path' }, { host: 'host:80' }, { host: '::1' }, { port: '80' }, { port: 80.5 }, { port: 0 }, { port: 65536 }, { scheme: 'FTP' }]) {
    assert.throws(() => config.validateServer({ ...server, ...change }), error => error.code === 'invalid_server');
  }
});

test('preview summary includes zero counts and replacement-only metadata', () => {
  assert.deepEqual(config.summarizeBackup({ userRules: [], serverList: [server], activeServerId: 'main' }, { userRules: ['old.example'], serverList: [] }), {
    fields: [
      { key: 'userRules', previousCount: 1, count: 0, clears: true },
      { key: 'serverList', previousCount: 0, count: 1, clears: false },
      { key: 'activeServerId', previousCount: null, count: null, clears: false },
    ],
  });
});
