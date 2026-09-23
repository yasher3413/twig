process.env.TZ = 'America/Toronto';
const { chromium } = await import(process.env.TWIG_PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = mkdtempSync(join(tmpdir(), 'twig-recall-'));
const browser = await chromium.launch({ headless: true, ...(process.env.TWIG_BROWSER_EXECUTABLE ? { executablePath: process.env.TWIG_BROWSER_EXECUTABLE } : {}) });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: 'light', timezoneId: 'America/Toronto' });
const errors = [];
const db = new DatabaseSync(':memory:');
db.exec("CREATE VIRTUAL TABLE page_text USING fts5(url UNINDEXED,title,body,captured_at UNINDEXED,tokenize='porter unicode61'); CREATE TABLE history(id INTEGER PRIMARY KEY,url TEXT,title TEXT,visited_at INTEGER); CREATE TABLE bookmarks(id INTEGER PRIMARY KEY,url TEXT,title TEXT,created_at INTEGER); CREATE TABLE archive(id INTEGER PRIMARY KEY,url TEXT,title TEXT,closed_at INTEGER)");
const now = Date.now(); const yesterday = now - 86400000;
db.prepare('INSERT INTO page_text VALUES (?,?,?,?)').run('https://legacy.example/', 'An earlier read', 'SQLite legacy reading copy.', now - 3 * 86400000);
db.exec(readFileSync(root + '/src-tauri/migrations/005_recall.sql', 'utf8'));
const insert = db.prepare('INSERT INTO recall_captures(url,title,body,captured_at,space_id,space_name,session_id) VALUES (?,?,?,?,?,?,?)');
insert.run('https://sqlite.org/notes', 'SQLite deployment notes', 'SQLite uses a single database file.\n\nThis older passage explains why a local application can keep deployment simple.\n\n<script>saved text is inert</script>', yesterday, 'work', 'Database research', 's1');
insert.run('https://sqlite.org/notes', 'SQLite deployment notes', 'SQLite now has an updated discussion. The older paragraph is gone from this version.', now - 60000, 'work', 'Database research', 's2');
insert.run('https://example.com/deployment', 'Deployment checklist', 'SQLite backups and deployment tradeoffs belong beside the original article.', yesterday - 300000, 'work', 'Database research', 's1');
insert.run('https://example.org/holiday', 'Holiday bookings', 'SQLite mention in a personal collection.', yesterday, 'personal', 'Personal', 's1');

try {
  // Execute the actual native extraction code against rendered DOM fixtures.
  const nativeSource = readFileSync(root + '/src-tauri/src/tabs/recall.rs', 'utf8');
  const captureScript = nativeSource.match(/const CAPTURE_SCRIPT: &str = r#"([\s\S]*?)"#;/)[1];
  const fixture = await context.newPage();
  await fixture.setContent('<style>.css-hidden{display:none}.invisible{visibility:hidden}.transparent{opacity:0}</style><article><h1>Visible title</h1><p>Visible <em>paragraph</em> text.</p><p>Another line<br>After break</p></article><form><p>FORM SECRET</p><input value="INPUT SECRET"><textarea>TEXTAREA SECRET</textarea></form><div contenteditable="true">EDITOR SECRET</div><div role="textbox">TEXTBOX SECRET</div><div hidden>HIDDEN SECRET</div><div aria-hidden="true">ARIA SECRET</div><div class="css-hidden"><span>CSS SECRET</span></div><div class="invisible">INVISIBLE SECRET</div><div class="transparent">TRANSPARENT SECRET</div><script>/* SCRIPT SECRET */</script>');
  const before = await fixture.content();
  const captured = JSON.parse(await fixture.evaluate(captureScript));
  assert.match(captured.b, /Visible paragraph text/);
  assert.match(captured.b, /Another line\n+After break/);
  assert.doesNotMatch(captured.b, /SECRET/);
  assert.equal(await fixture.content(), before, 'capture must not mutate the page');
  for (const mode of ['body-editable', 'html-editable', 'body-textbox', 'design-mode']) {
    await fixture.setContent('<p>DRAFT SECRET</p>');
    await fixture.evaluate(mode => {
      document.documentElement.removeAttribute('contenteditable'); document.designMode = 'off';
      if (mode === 'body-editable') document.body.contentEditable = 'true';
      if (mode === 'html-editable') document.documentElement.contentEditable = 'true';
      if (mode === 'body-textbox') document.body.setAttribute('role', 'textbox');
      if (mode === 'design-mode') document.designMode = 'on';
    }, mode);
    assert.equal(JSON.parse(await fixture.evaluate(captureScript)).b, '', mode);
  }
  await fixture.close();

  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  let sqlFailure = false;
  let delayFirstSearch = false; let releaseSearch;
  let firstSearchEntered;
  const searchEntered = new Promise(resolve => firstSearchEntered = resolve);
  await page.exposeFunction('testSql', async (command, query, values) => {
    if (sqlFailure && query.includes('recall')) throw new Error('Recall database unavailable');
    const statement = db.prepare(query);
    const bindings = Object.fromEntries(values.map((value, i) => ['$' + (i + 1), value]));
    if (command === 'plugin:sql|select') {
      const rows = statement.all(bindings);
      if (delayFirstSearch && query.includes('recall_fts MATCH')) {
        delayFirstSearch = false; firstSearchEntered(); await new Promise(resolve => releaseSearch = resolve);
      }
      return rows;
    }
    const result = statement.run(bindings); return [Number(result.changes), Number(result.lastInsertRowid)];
  });
  await page.addInitScript(() => {
    const callbacks = new Map(); const listeners = new Map(); let next = 1;
    window.testCalls = []; window.testOpenFailure = false;
    window.testState = { tabs: [{ id: '1', url: 'https://sqlite.org/notes', title: 'SQLite deployment notes', status: 'hot', groupId: 'work' }], activeId: '1', splitId: null,
      groups: [{ id: 'work', name: 'Database research' }], activeGroupId: 'work', tabStripVisible: true, isPrivate: false };
    window.fireEvent = (event, payload) => { for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ payload }); };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
      transformCallback(callback) { const id = next++; callbacks.set(id, callback); return id; },
      async invoke(command, args = {}) {
        window.testCalls.push({ command, args });
        if (command === 'plugin:event|listen') { const list = listeners.get(args.event) ?? []; list.push(args.handler); listeners.set(args.event, list); return args.handler; }
        if (command === 'plugin:event|unlisten') { listeners.set(args.event, (listeners.get(args.event) ?? []).filter(id => id !== args.eventId)); return; }
        if (command.startsWith('plugin:sql|')) return window.testSql(command, args.query, args.values);
        if (command === 'list_tabs') return structuredClone(window.testState);
        if (command === 'open_recalled_page') {
          if (window.testOpenFailure) throw new Error('Could not create the live tab');
          return { id: '2', title: 'Recalled page', url: args.url, status: 'hot', groupId: 'work' };
        }
        if (command === 'memory_stats') return { footprintKb: 100, processCount: 1, awakeTabs: 1, sleepingTabs: 0, estimatedSavedKb: 0 };
        return null;
      },
    };
  });
  await page.goto(process.env.TWIG_TEST_URL || 'http://127.0.0.1:1420');
  await page.getByRole('button', { name: 'Open recall', exact: true }).click();
  await page.locator('.recall-result').nth(4).waitFor();
  const search = page.getByLabel('Search saved page text');
  await search.fill('SQLite');
  await page.locator('.recall-result mark').first().waitFor();
  const oldResult = page.locator('.recall-result').filter({ hasText: 'single database file' });
  await oldResult.click();
  await page.getByLabel('Saved page text', { exact: true }).filter({ hasText: 'older passage' }).waitFor();
  assert.equal(await page.locator('.recall-reading-text script').count(), 0);
  await page.getByRole('region', { name: 'Nearby browsing activity' }).getByRole('button', { name: /Deployment checklist/ }).waitFor();
  if (process.env.CAPTURE) {
    await page.screenshot({ path: join(artifacts, 'recall-light.png') });
    await page.evaluate(async () => { const { useSettingsStore } = await import('/src/store/settings.ts'); useSettingsStore.getState().setThemeMode('dark'); });
    await page.screenshot({ path: join(artifacts, 'recall-dark.png') });
    await page.evaluate(async () => { const { useSettingsStore } = await import('/src/store/settings.ts'); useSettingsStore.getState().setThemeMode('light'); });
    await page.setViewportSize({ width: 700, height: 850 });
    await page.screenshot({ path: join(artifacts, 'recall-narrow.png') });
    assert.equal(await page.locator('dialog.recall').evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.setViewportSize({ width: 1200, height: 900 });
  }
  await page.getByLabel('Filter by space').selectOption('personal');
  await page.waitForFunction(() => document.querySelectorAll('.recall-result').length === 1 && document.querySelector('.recall-result')?.textContent.includes('Holiday'));
  await page.getByLabel('Filter by space').selectOption('__unknown__');
  await page.waitForFunction(() => document.querySelectorAll('.recall-result').length === 1 && document.querySelector('.recall-result')?.textContent.includes('earlier read'));
  await page.getByRole('button', { name: 'All time', exact: true }).click();
  await page.locator('.recall-result').nth(4).waitFor();
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.recall-result').length === 1 && document.querySelector('.recall-result')?.textContent.includes('updated discussion'));
  await page.getByLabel('Captured from').fill(`${new Date().getFullYear() + 2}-01-01`);
  await page.getByRole('alert').filter({ hasText: 'start date' }).waitFor();
  await page.getByRole('button', { name: 'All time', exact: true }).click();
  await page.locator('.recall-result').nth(4).waitFor();

  // A delayed response to an old query must never replace the newer search.
  delayFirstSearch = true;
  await search.fill('SQLite');
  await page.getByRole('button', { name: 'Last 7 days', exact: true }).click();
  await searchEntered;
  await search.fill('holiday');
  await page.waitForFunction(() => document.querySelectorAll('.recall-result').length === 1 && document.querySelector('.recall-result')?.textContent.includes('Holiday'));
  releaseSearch();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.recall-result').count(), 1);
  assert.match(await page.locator('.recall-result').innerText(), /Holiday/);

  sqlFailure = true;
  await search.fill('broken');
  await page.getByRole('alert').filter({ hasText: 'database unavailable' }).waitFor();
  sqlFailure = false;
  await page.getByRole('button', { name: 'Retry search', exact: true }).click();
  await page.getByRole('heading', { name: 'No passages found' }).waitFor();
  await search.fill('SQLite');
  await oldResult.click();
  await page.getByLabel('Saved page text', { exact: true }).filter({ hasText: 'older passage' }).waitFor();
  await page.evaluate(() => window.testOpenFailure = true);
  await page.getByRole('button', { name: 'Open live page at passage', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not create' }).waitFor();
  await page.evaluate(() => window.testOpenFailure = false);
  await page.getByRole('button', { name: 'Open live page at passage', exact: true }).click();
  await page.locator('dialog.recall').waitFor({ state: 'detached' });
  const live = await page.evaluate(() => window.testCalls.filter(call => call.command === 'open_recalled_page').at(-1).args);
  assert.equal(live.url, 'https://sqlite.org/notes'); assert.match(live.passage, /single database file/); assert.doesNotMatch(live.passage, /\[\[/);

  await page.evaluate(() => window.fireEvent('menu-action', 'show-recall'));
  await search.fill('SQLite'); await oldResult.click();
  await page.getByLabel('Saved page text', { exact: true }).filter({ hasText: 'older passage' }).waitFor();
  await page.getByRole('button', { name: 'Delete this copy…', exact: true }).click();
  await page.getByRole('button', { name: 'Keep it', exact: true }).click();
  assert.equal(db.prepare('SELECT count(*) n FROM recall_captures').get().n, 5);
  await page.getByRole('button', { name: 'Delete this copy…', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Saved text removed' }).waitFor();
  assert.equal(db.prepare('SELECT count(*) n FROM recall_captures').get().n, 4);
  await page.locator('.recall-result').filter({ hasText: 'updated discussion' }).click();
  await page.getByLabel('Saved page text', { exact: true }).filter({ hasText: 'updated discussion' }).waitFor();
  await page.getByRole('button', { name: 'Forget this page…', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.recall-result-url')?.textContent.includes('sqlite.org/notes'));
  assert.equal(db.prepare('SELECT count(*) n FROM recall_captures WHERE url=?').get('https://sqlite.org/notes').n, 0);
  await page.keyboard.press('Escape');
  await page.locator('dialog.recall').waitFor({ state: 'detached' });

  // Native capture event traverses the actual App -> SQL path.
  await page.evaluate(() => window.fireEvent('page-captured', { url: 'https://example.com/new', title: 'New capture', body: 'A newly captured passage', capturedAt: Date.now(), spaceId: 'work', spaceName: 'Database research', sessionId: 's3' }));
  await page.waitForFunction(() => window.testCalls.some(call => call.command === 'plugin:sql|execute' && call.args.values?.includes('A newly captured passage')));
  await page.evaluate(() => window.fireEvent('menu-action', 'settings'));
  const clear = page.getByRole('button', { name: 'Clear history', exact: true });
  await clear.waitFor(); await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(el => el.textContent === 'Clear history')?.disabled);
  await clear.click();
  await page.getByText('History and saved reading copies cleared.', { exact: true }).waitFor();
  assert.equal(db.prepare('SELECT count(*) n FROM recall_captures').get().n, 0);
  await page.locator('.settings-close').click();
  await page.evaluate(() => window.fireEvent('tabs-changed', { ...window.testState, isPrivate: true }));
  await page.getByRole('button', { name: 'Open recall', exact: true }).waitFor({ state: 'detached' });
  const privateStart = await page.evaluate(() => window.testCalls.length);
  await page.evaluate(() => { window.fireEvent('menu-action', 'show-recall'); window.fireEvent('menu-action', 'show-history'); window.fireEvent('menu-action', 'command-palette'); });
  await page.locator('.palette-input').fill('private lookup');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('dialog.recall').count(), 0);
  assert.equal(await page.locator('.library').count(), 0);
  assert.equal(await page.evaluate(start => window.testCalls.slice(start).filter(call => call.command.startsWith('plugin:sql|')).length, privateStart), 0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.fireEvent('menu-action', 'settings'));
  assert.equal(await clear.isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS: native extraction excludes editable roots/inherited editability/designMode/forms/CSS-hidden text without DOM mutation; real-SQLite Recall workflow passes search, versions, space/date filters, nearby context, stale-query rejection, errors/retry, live passage payload, deletes, capture indexing, history clear, and private palette/settings guards.');
  if (process.env.CAPTURE) console.log(`Screenshots: ${artifacts}`);
} finally { db.close(); await browser.close(); }
