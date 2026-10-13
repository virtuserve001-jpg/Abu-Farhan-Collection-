/**
 * Unit tests for the CRDT data layer — no browser, no server, no network.
 * Run with: npm test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'

import { base64ToBytes, bytesToBase64, createStore, savedRooms } from '../src/store.js'

/** Minimal in-memory stand-in for localStorage. */
function fakeStorage() {
  const map = new Map()
  return {
    get length() {
      return map.size
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map
  }
}

/** Bridge two documents directly, the way the WebRTC transport would. */
function link(a, b) {
  const apply = (doc, update) => Y.applyUpdate(doc, update, 'remote')
  const fromA = (update, origin) => origin !== 'remote' && apply(b.doc, update)
  const fromB = (update, origin) => origin !== 'remote' && apply(a.doc, update)
  a.doc.on('update', fromA)
  b.doc.on('update', fromB)
  return () => {
    a.doc.off('update', fromA)
    b.doc.off('update', fromB)
  }
}

test('base64 round-trip preserves binary data', () => {
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
  assert.deepEqual([...base64ToBytes(bytesToBase64(bytes))], [...bytes])
})

test('two peers converge when both edit at the same time', () => {
  const storage = fakeStorage()
  const a = createStore('room-1', { storage, saveDebounceMs: 0 })
  const b = createStore('room-1', { storage, saveDebounceMs: 0 })
  const unlink = link(a, b)

  a.addItem({ title: 'Diwan al-Mutanabbi', category: 'Poetry', addedBy: 'Aisha' })
  b.addItem({ title: 'Tafsir Ibn Kathir', category: 'Tafsir', addedBy: 'Yusuf' })

  const titles = (store) => store.listItems().map((item) => item.title).sort()
  assert.deepEqual(titles(a), titles(b))
  assert.equal(titles(a).length, 2, 'concurrent inserts are merged, not overwritten')

  unlink()
})

test('a peer that joins late inherits the accumulated state', () => {
  const a = createStore('room-2', { storage: fakeStorage() })
  a.addItem({ title: 'Book of Reminders', addedBy: 'Aisha' })
  a.setNotes('first line\nsecond line')

  // A late joiner starts empty and receives the encoded document state.
  const late = createStore('room-2', { storage: fakeStorage() })
  assert.equal(late.listItems().length, 0)

  Y.applyUpdate(late.doc, a.encodeState(), 'remote')
  assert.equal(late.listItems()[0].title, 'Book of Reminders')
  assert.equal(late.getNotes(), 'first line\nsecond line')
})

test('text editing produces a minimal diff (character-level merge)', () => {
  const a = createStore('room-3', { storage: fakeStorage() })
  const b = createStore('room-3', { storage: fakeStorage() })
  const unlink = link(a, b)

  a.setNotes('Hello world')
  b.setNotes('Hello brave world')

  assert.equal(a.getNotes(), b.getNotes())
  assert.equal(b.getNotes(), 'Hello brave world')
  unlink()
})

test('deletes propagate to every peer', () => {
  const a = createStore('room-4', { storage: fakeStorage() })
  const b = createStore('room-4', { storage: fakeStorage() })
  const unlink = link(a, b)

  a.addItem({ title: 'Fihrist', addedBy: 'Aisha' })
  b.removeItem(b.listItems()[0].id)

  assert.equal(a.listItems().length, 0)
  assert.equal(b.listItems().length, 0)
  unlink()
})

test('state is persisted per room and restored on reload', async () => {
  const storage = fakeStorage()
  const first = createStore('room-5', { storage, saveDebounceMs: 0 })
  first.addItem({ title: 'Al-Muwatta', addedBy: 'Yusuf' })

  await new Promise((resolve) => setTimeout(resolve, 5))

  assert.deepEqual(savedRooms(storage), ['room-5'])

  const second = createStore('room-5', { storage, saveDebounceMs: 0 })
  assert.equal(second.listItems()[0].title, 'Al-Muwatta')

  const otherRoom = createStore('room-6', { storage, saveDebounceMs: 0 })
  assert.equal(otherRoom.listItems().length, 0, 'rooms are isolated from each other')
})

test('the same text typed twice by two peers does not duplicate', () => {
  const a = createStore('room-7', { storage: fakeStorage() })
  const b = createStore('room-7', { storage: fakeStorage() })
  const unlink = link(a, b)

  a.setNotes('note')
  b.setNotes('note')

  assert.equal(a.getNotes(), 'note')
  assert.equal(b.getNotes(), 'note')
  unlink()
})
