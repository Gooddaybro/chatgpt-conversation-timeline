const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the real manager methods; browser integration covers DOM selection/layout.
const observers = [];
const context = vm.createContext({
  location: { pathname: '/c/test', href: 'https://chatgpt.com/c/test' },
  document: { body: {} },
  MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} },
  setTimeout,
  clearTimeout,
  CSS: { escape: value => value },
  ChatGPTInitialJumpUtils: require('../extension/chatgpt-initial-jump-utils.js')
});
vm.runInContext(fs.readFileSync(require.resolve('../extension/content-chatgpt.js'), 'utf8') +
  '\nglobalThis.ManagerForTest = TimelineManager; globalThis.ActiveTurnForTest = isActiveTurn;', context);

let failures = 0;
function run(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (error) { failures++; console.error(`not ok - ${name}: ${error.message}`); }
}

run('modern summaries contain only the user bubble, excluding answer and date', () => {
  const manager = new context.ManagerForTest();
  const turn = {
    dataset: { turnKey: 'modern-1' },
    textContent: 'Today You said: Find the first step ChatGPT said: A long answer',
    querySelector: selector => selector === '[data-user-message-bubble]' ? { textContent: 'Find the first step' } : null
  };
  assert.equal(manager.resolveSummary(turn), 'Find the first step');
  assert.equal(manager.summaryCache.get('modern-1'), 'Find the first step');
});

run('legacy summary behavior and stable ID remain intact', () => {
  const manager = new context.ManagerForTest();
  const turn = { dataset: { turnId: 'legacy-1' }, textContent: 'Legacy question', querySelector: () => null };
  assert.equal(manager.resolveSummary(turn), 'Legacy question');
  assert.equal(manager.summaryCache.get('legacy-1'), 'Legacy question');
});

run('virtualized modern turns keep their cached user summary instead of answer text', () => {
  const manager = new context.ManagerForTest();
  manager.summaryCache.set('modern-2', 'Cached question');
  const turn = { dataset: { turnKey: 'modern-2' }, textContent: 'An assistant answer remains', querySelector: () => null };
  assert.equal(manager.resolveSummary(turn), 'Cached question');
});

run('jump lookup accepts modern turn keys and targets the user bubble', () => {
  const manager = new context.ManagerForTest();
  const bubble = { textContent: 'Modern question' };
  const turn = { dataset: { turnKey: 'modern-1' }, querySelector: selector => selector === '[data-user-message-bubble]' ? bubble : null };
  manager.conversationContainer = {
    querySelector: selector => selector.includes('[data-turn-key="modern-1"]') ? turn : null
  };
  const target = manager.resolvePendingJumpTarget({ targetId: 'modern-1' });
  assert.ok(target, 'modern turn must be found');
  assert.equal(target.targetElement, bubble);
});

run('user-turn selection keeps cached virtualized turns and excludes assistant-only turns', () => {
  const manager = new context.ManagerForTest();
  const legacy = { dataset: { turn: 'user', turnId: 'old' }, querySelector: () => null };
  const modern = { dataset: { turnKey: 'new' }, querySelector: () => ({ textContent: 'Question' }) };
  const cached = { dataset: { turnKey: 'cached' }, querySelector: () => null };
  const assistant = { dataset: { turnKey: 'assistant' }, querySelector: () => null };
  manager.summaryCache.set('cached', 'Cached question');
  manager.conversationContainer = { querySelectorAll: () => [legacy, modern, cached, assistant] };
  assert.deepEqual(Array.from(manager.getUserTurnElements()), [legacy, modern, cached]);
});

run('cached modern turn without a bubble anchors to the turn, never its assistant answer', () => {
  const manager = new context.ManagerForTest();
  const answer = { innerText: 'Assistant answer', textContent: 'Assistant answer' };
  const turn = {
    dataset: { turnKey: 'virtualized' },
    querySelector: () => null,
    querySelectorAll: () => [answer]
  };
  assert.equal(manager.resolveTurnScrollAnchor(turn), turn);
});

run('image-only user messages remain selectable and anchor to their user unit', () => {
  const manager = new context.ManagerForTest();
  const userUnit = { textContent: '' };
  const turn = { dataset: { turnKey: 'image' }, querySelector: selector =>
    selector === '[data-chatgpt-search-unit-key$=":user"]' ? userUnit : null };
  manager.conversationContainer = { querySelectorAll: () => [turn] };
  assert.equal(manager.getUserTurnElements().length, 1);
  assert.equal(manager.resolveTurnScrollAnchor(turn), userUnit);
});


run('hidden cached ChatGPT workspaces never leak previous conversation entries', () => {
  const manager = new context.ManagerForTest();
  const hiddenWorkspace = { style: { display: 'none' }, parentElement: null };
  const previous = { dataset: { turnKey: 'old-chat' }, parentElement: hiddenWorkspace, querySelector: () => ({ textContent: 'Old question' }) };
  const current = { dataset: { turnKey: 'current-chat' }, parentElement: null, querySelector: () => ({ textContent: 'Current question' }) };
  manager.conversationContainer = { querySelectorAll: () => [previous, current] };
  assert.deepEqual(Array.from(manager.getUserTurnElements()), [current]);
});

if (failures) process.exitCode = 1;

(async () => {
  try {
    const hidden = { style: { display: 'none' } };
    const previous = { parentElement: hidden };
    let turns = [previous];
    context.document.querySelector = () => turns[0];
    context.document.querySelectorAll = () => turns;
    const manager = new context.ManagerForTest();
    let settled = false;
    const pending = manager.waitForElement('[data-turn-key]', context.ActiveTurnForTest).then(value => { settled = true; return value; });
    await Promise.resolve();
    assert.equal(settled, false, 'hidden cached turns must not complete initialization');
    const current = { parentElement: null };
    turns.push(current);
    observers.at(-1).callback([]);
    assert.equal(await pending, current);
    console.log('ok - initialization waits until an active workspace arrives after hidden cached turns');
  } catch (error) {
    console.error(`not ok - delayed active workspace: ${error.message}`);
    process.exitCode = 1;
  }
})();
