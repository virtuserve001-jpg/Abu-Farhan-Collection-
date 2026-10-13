/**
 * smoke.dom.mjs — boots the real bundle inside a headless DOM to prove the app
 * wires up without exceptions (DOM lookups, CRDT store, Trystero room, UI
 * renders). It needs outbound WebSocket access for the relay sockets; if the
 * sandbox blocks that, the relays simply report as unreachable, which is a
 * valid state the UI handles.
 *
 *   npm run smoke
 */
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const dom = new JSDOM(html, {
  url: 'https://example.com/#room=smoke-test&name=Tester',
  pretendToBeVisual: true
})

const { window } = dom
window.WebSocket = globalThis.WebSocket // Node's undici WebSocket

const failures = []
window.addEventListener('error', (event) => failures.push(String(event.error ?? event.message)))
process.on('unhandledRejection', (error) => failures.push(`unhandledRejection: ${error}`))

globalThis.window = window
globalThis.self = window
// Trystero watches the online/offline events on the global scope.
globalThis.addEventListener = (...args) => window.addEventListener(...args)
globalThis.removeEventListener = (...args) => window.removeEventListener(...args)

for (const key of [
  'document',
  'location',
  'navigator',
  'HTMLElement',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'WebSocket',
  'AbortController',
  'AbortSignal',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame'
]) {
  const value = window[key] ?? globalThis[key]
  if (value !== undefined) {
    try {
      globalThis[key] = value
    } catch {
      Object.defineProperty(globalThis, key, { value, configurable: true })
    }
  }
}

const assert = (label, condition) => {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}`)
  if (!condition) process.exitCode = 1
}

await import('../bundle.js')

// Let the async parts settle: relay sockets, timers, the first status tick.
await new Promise((resolve) => setTimeout(resolve, 4000))

const text = (selector) => window.document.querySelector(selector)?.textContent?.trim() ?? ''
const value = (selector) => window.document.querySelector(selector)?.value ?? ''

console.log('\n--- app state after boot ---')
console.log('status badge :', text('#status-badge'))
console.log('relay badge  :', text('#relay-badge'))
console.log('peer badge   :', text('#peer-badge'))
console.log('presence     :', text('#presence-list').replace(/\s+/g, ' '))
console.log('pseudo peer  :', text('#diag-self'))
console.log('relay config :', value('#relay-input'))

assert('room id rendered in the input', value('#room-input') === 'smoke-test')
assert('own name shown', value('#name-input') === 'Tester')
assert('self is listed in presence', text('#presence-list').includes('Tester (you)'))
assert('presence count is 1', text('#presence-count') === '1')
assert('status badge has text', text('#status-badge').length > 0)
assert('peer id is rendered', /^[0-9a-z]{16,}$/i.test(text('#diag-self')))
assert('relays are configured', value('#relay-input').split(',').length >= 3)
assert('empty-state hint for the catalog', window.document.querySelector('#catalog-empty') !== null)

// ---- exercise the catalog through the real DOM handlers ----
const titleInput = window.document.querySelector('#item-title')
const categoryInput = window.document.querySelector('#item-category')
titleInput.value = 'Al-Muwatta'
categoryInput.value = 'Hadith'
window.document
  .querySelector('#item-form')
  .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))

await new Promise((resolve) => setTimeout(resolve, 100))

const catalogHtml = window.document.querySelector('#catalog-list').innerHTML
assert('added item rendered', catalogHtml.includes('Al-Muwatta'))
assert('item shows who added it', catalogHtml.includes('Tester'))
assert('category datalist updated', window.document.querySelector('#categories').innerHTML.includes('Hadith'))
assert('title input cleared after submit', titleInput.value === '')

// ---- exercise the shared note + chat through their handlers ----
const notes = window.document.querySelector('#notes')
notes.value = 'hello from the smoke test'
notes.dispatchEvent(new window.Event('input', { bubbles: true }))

const chatInput = window.document.querySelector('#chat-input')
chatInput.value = 'salaam'
window.document
  .querySelector('#chat-form')
  .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))

await new Promise((resolve) => setTimeout(resolve, 150))
const chatHtml = window.document.querySelector('#chat-log').innerHTML
assert('own chat message rendered', chatHtml.includes('salaam'))
assert('chat is attributed to the sender', chatHtml.includes('Tester'))
assert('note was written into the CRDT', notes.value === 'hello from the smoke test')

// The store debounces writes by ~400 ms.
await new Promise((resolve) => setTimeout(resolve, 700))

console.log('\n--- persisted payload ---')
const keys = Object.keys(window.localStorage)
console.log(keys.map((key) => `${key} (${String(window.localStorage.getItem(key)).length} chars)`))
assert('CRDT state persisted for the room', keys.includes('afc:v1:doc:smoke-test'))
assert('identity persisted', keys.includes('afc:name'))

console.log('\n--- runtime errors captured ---')
console.log(failures.length ? failures : '(none)')
assert('no uncaught runtime errors', failures.length === 0)

// Leave the room so Trystero's sockets don't keep the process alive.
window.document.querySelector('#leave-btn').dispatchEvent(new window.Event('click', { bubbles: true }))
await new Promise((resolve) => setTimeout(resolve, 300))
dom.window.close()
process.exit(process.exitCode ?? 0)
