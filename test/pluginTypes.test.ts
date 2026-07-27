import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TriggerType, flattenManifestFile } from '../src/types/PluginTypes';

test('TriggerType exposes the expected trigger values', () => {
  assert.equal(TriggerType.MANUAL, 'manual');
  assert.equal(TriggerType.SCHEDULE, 'schedule');
  assert.equal(TriggerType.EVENT, 'event');
  assert.equal(TriggerType.WEBHOOK, 'webhook');
  assert.equal(TriggerType.API, 'api');
  assert.equal(TriggerType.CHAT, 'chat');
});

test('TriggerType values are usable where PluginManifest.trigger_type is expected', () => {
  const triggers: TriggerType[] = [TriggerType.MANUAL, TriggerType.API];
  assert.deepEqual(triggers, ['manual', 'api']);
});

test('flattenManifestFile passes a single-object manifest through unchanged', () => {
  const manifest = { id: 'a', name: 'a', description: 'x', input: {} };
  assert.equal(flattenManifestFile(manifest), manifest);
});

test('flattenManifestFile expands { ...commonFields, plugins: [...] } into a flat array, merging common fields', () => {
  const raw = {
    version: '1.0.0',
    author: 'Jane',
    plugins: [
      { id: 'a', name: 'summarize-ticket', description: 'x', input: {}, func: 'summarizeTicket' },
      { id: 'b', name: 'tag-urgency', description: 'y', input: {}, func: 'tagUrgency', author: 'John' },
    ],
  };
  const flattened = flattenManifestFile(raw);
  assert.deepEqual(flattened, [
    { version: '1.0.0', author: 'Jane', id: 'a', name: 'summarize-ticket', description: 'x', input: {}, func: 'summarizeTicket' },
    { version: '1.0.0', author: 'John', id: 'b', name: 'tag-urgency', description: 'y', input: {}, func: 'tagUrgency' },
  ]);
});

test('flattenManifestFile rejects a bare top-level array', () => {
  assert.throws(
    () => flattenManifestFile([{ id: 'a', name: 'a', description: 'x', input: {}, func: 'a' }]),
    /cannot be a bare JSON array/,
  );
});
