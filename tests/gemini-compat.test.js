const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function environment() {
  let nextId = 0;
  const frames = new Map();
  const timers = new Map();
  const observers = [];
  const viewportListeners = new Set();
  const document = { body: {}, documentElement: {}, querySelector: () => null, querySelectorAll: () => [] };
  const context = vm.createContext({
    document, location: { pathname: '/u/0/app/test-chat', href: 'https://gemini.google.com/u/0/app/test-chat' },
    window: { addEventListener() {}, removeEventListener() {}, visualViewport: {
      addEventListener: (event, fn) => viewportListeners.add(fn),
      removeEventListener: (event, fn) => viewportListeners.delete(fn)
    } },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
      observe(target, options) { this.options = options; }
      disconnect() { this.disconnected = true; }
    },
    AbortController,
    requestAnimationFrame: fn => { const id = ++nextId; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: fn => { const id = ++nextId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++nextId, clearInterval() {},
    console: { debug() {} }
  });
  const source = fs.readFileSync(require.resolve('../extension/content-gemini.js'), 'utf8');
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, `
    globalThis.GeminiForTest = { GeminiTimelineScaffold, waitForElement, findConversationRootFromFirst,
      isConversationRouteGemini, extractConversationIdFromPath };
  })();`), context);
  return { ...context.GeminiForTest, document, frames, timers, observers, viewportListeners };
}

let failures = 0;
async function run(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { failures++; console.error(`not ok - ${name}: ${error.message}`); }
}

(async () => {
  await run('Gemini has its own content-script and stylesheet without extra API permissions', () => {
    const manifest = JSON.parse(fs.readFileSync(require.resolve('../extension/manifest.json'), 'utf8'));
    const gemini = manifest.content_scripts.find(entry => entry.matches.includes('https://gemini.google.com/*'));
    assert.ok(gemini, 'Gemini content script must be declared');
    assert.ok(gemini.js.includes('content-gemini.js'));
    assert.ok(gemini.css.includes('styles-gemini.css'));
    assert.deepEqual(manifest.permissions, ['storage']);
  });

  await run('account-prefixed chat routes are recognized, new chat is not a conversation', () => {
    const env = environment();
    assert.equal(env.isConversationRouteGemini('/u/0/app/abc123'), true);
    assert.equal(env.extractConversationIdFromPath('/u/1/app/abc123'), 'abc123');
    assert.equal(env.isConversationRouteGemini('/u/0/app'), false);
  });

  await run('multi-line questions keep their complete text, excluding controls', () => {
    const env = environment();
    const manager = new env.GeminiTimelineScaffold();
    const visible = { textContent: 'first line\nsecond line', querySelectorAll: () => [] };
    const element = { textContent: 'first line second line Expand', querySelector: selector =>
      selector === '.query-text' ? { ...visible, cloneNode: () => visible } : { textContent: 'first line' } };
    assert.equal(manager.extractUserSummary(element), 'first line second line');
  });

  await run('Gemini accessibility labels do not duplicate the visible question', () => {
    const env = environment();
    const manager = new env.GeminiTimelineScaffold();
    const copy = { textContent: 'You said first line first line second line' };
    copy.querySelectorAll = selector => selector === '.screen-reader-user-query-label'
      ? [{ remove() { copy.textContent = 'first line second line'; } }] : [];
    const element = { querySelector: () => ({ textContent: copy.textContent, cloneNode: () => copy }) };
    assert.equal(manager.extractUserSummary(element), 'first line second line');
  });

  await run('single-message conversations observe the history container for future sibling turns', () => {
    const env = environment();
    const parent = { contains: () => true };
    const first = { parentElement: parent };
    const history = { contains: element => element === first };
    env.document.querySelector = selector => selector.includes('chat-history-container') ? history : null;
    env.document.querySelectorAll = () => [first];
    assert.equal(env.findConversationRootFromFirst(first), history);
  });

  await run('cancelled initialization disconnects its observer and timeout', async () => {
    const env = environment();
    const controller = new AbortController();
    const pending = env.waitForElement('user-query', 5000, controller.signal);
    controller.abort();
    // The old implementation ignores abort; delivering its normal match keeps this regression deterministic.
    const observer = env.observers.at(-1);
    env.document.querySelector = () => ({ textContent: 'late message' });
    observer.callback([]);
    assert.equal(await pending, null);
    assert.equal(observer.disconnected, true);
    assert.equal(env.timers.size, 0);
  });

  await run('native Gemini conversation IDs identify repeated identical questions', () => {
    const env = environment();
    const manager = new env.GeminiTimelineScaffold();
    manager.conversationContainer = {};
    manager.scrollContainer = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }) };
    manager.trackContent = { querySelectorAll: () => [] };
    const node = { getAttribute: () => null, setAttribute() {}, closest: () => ({ id: 'native-turn-42' }),
      getBoundingClientRect: () => ({ top: 20 }) };
    manager.collectUserNodes = () => [node];
    manager.extractUserSummary = () => 'same question';
    manager.rebuildMarkersPhase4();
    assert.equal(manager.markers[0].id, 'native-turn-42');
  });

  await run('empty conversation clears marker state as well as rendered dots', () => {
    const env = environment();
    const manager = new env.GeminiTimelineScaffold();
    manager.conversationContainer = {};
    manager.scrollContainer = {};
    manager.trackContent = { querySelectorAll: () => [] };
    manager.collectUserNodes = () => [];
    manager.markers = [{ id: 'previous-conversation' }];
    manager.rebuildMarkersPhase4();
    assert.equal(manager.markers.length, 0);
    assert.equal(manager.activeIdx, -1);
  });

  await run('streaming text-node edits trigger content observation', () => {
    const env = environment();
    const manager = new env.GeminiTimelineScaffold();
    manager.conversationContainer = {};
    manager.attachContentObserver();
    assert.equal(manager.mutationObserver.options.characterData, true);
  });

  await run('destroy disconnects layout and visibility observers and viewport callbacks', () => {
    const env = environment();
    const manager = new env.GeminiTimelineScaffold();
    const makeObserver = () => ({ disconnected: false, disconnect() { this.disconnected = true; } });
    const owned = [makeObserver(), makeObserver(), makeObserver()];
    [manager.themeObserver, manager.resizeObserver, manager.intersectionObserver] = owned;
    manager.onVisualViewportResize = () => {};
    env.viewportListeners.add(manager.onVisualViewportResize);
    manager.destroy();
    assert.ok(owned.every(observer => observer.disconnected));
    assert.equal(env.viewportListeners.size, 0);
  });

  await run('rapid jumps and destroy leave no stale scrolling animation', () => {
    const env = environment();
    const manager = new env.GeminiTimelineScaffold();
    manager.scrollContainer = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }) };
    const target = { isConnected: true, getBoundingClientRect: () => ({ top: 100 }) };
    manager.scrollToMessage(target);
    manager.scrollToMessage(target);
    assert.equal(env.frames.size, 1);
    manager.destroy();
    assert.equal(env.frames.size, 0);
  });

  if (failures) process.exitCode = 1;
})();
