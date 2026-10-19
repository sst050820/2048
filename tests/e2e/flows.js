// Menus and game flow with a real mouse on a desktop window: aim, cancel,
// launch, pause, save and continue, loss, game over card, themes.
const { run, check, watch, screenOf, mouseDrag, OUT } = require('./lib');

run(async ({ browser, url }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const p = await ctx.newPage();
  const errors = watch(p);
  await p.goto(url); await p.waitForTimeout(600);
  check('title shows on launch', await p.isVisible('#title'));
  check('start button reads 开始游戏 with no save', (await p.textContent('#btn-play')) === '开始游戏');
  check('the original dark mode colours are the default', await p.evaluate(() => SB.game.style === 'dark_mode'));
  await p.click('#btn-play'); await p.waitForTimeout(2500);
  check('desktop window gets the desktop layout', await p.evaluate(() => SB.game.mode.layoutName === 'desktop'));

  const q = await p.evaluate(() => { const s = SB.game.mode.selectable[0]; return SB.game.renderer.toScreen(s.cx, s.cy); });
  await p.mouse.move(q.x, q.y); await p.mouse.down(); await p.mouse.move(q.x + 40, q.y + 80, { steps: 4 });
  check('pressing a bar sobo starts aiming', await p.evaluate(() => !!SB.game.mode.aim));
  await p.mouse.down({ button: 'right' }); await p.mouse.up({ button: 'right' });
  check('right click cancels the aim', await p.evaluate(() => !SB.game.mode.aim));
  await p.mouse.up();
  check('a cancelled sobo stays on the bar', await p.evaluate(() => SB.game.mode.stack.length === 0));

  await mouseDrag(p, q, { x: q.x, y: q.y + 120 });
  await p.waitForTimeout(1200);
  check('releasing launches the sobo the way the drag points', await p.evaluate(() => SB.game.mode.stack.length === 1 && SB.game.mode.stack[0].cy > -100));

  await p.keyboard.press('Escape');
  check('Escape pauses', await p.isVisible('#pause'));
  const count = await p.evaluate(() => SB.game.mode.world.sobos.length);
  await p.click('#btn-home'); await p.waitForTimeout(300);
  await p.reload(); await p.waitForTimeout(600);
  check('continue is offered after a reload', await p.isVisible('#btn-continue'));
  await p.click('#btn-continue'); await p.waitForTimeout(300);
  check('continue restores the board', await p.evaluate(n => SB.game.mode.world.sobos.length === n && SB.game.app.screen === 'play', count), `${count} sobos`);

  await p.evaluate(() => SB.game.mode.sides.forEach(s => { s.bumper.x = s.bumper.restX + s.bumper.dir * 32; s.bumper.vx = 0; }));
  await p.waitForTimeout(400);
  check('both bumpers out starts the loss', await p.evaluate(() => SB.game.mode.state === 'pregameover'));
  check('the save is deleted at the loss', await p.evaluate(() => !SB.game.store.get('game', null)));
  await p.waitForTimeout(3300);
  check('game over card after the 3 s freeze', await p.isVisible('#over'));
  await p.waitForTimeout(2000);
  await p.screenshot({ path: OUT + '/flows-over.png' });
  await p.click('#btn-view'); await p.waitForTimeout(200);
  check('view board hides the card', !(await p.isVisible('#over')));
  await p.mouse.click(640, 360); await p.waitForTimeout(200);
  check('a click brings the card back', await p.isVisible('#over'));
  await p.click('#btn-over-home'); await p.waitForTimeout(300);

  await p.evaluate(() => { SB.game.app.screen = 'play'; SB.game.unlock('score_0'); SB.game.unlock('8192'); SB.game.app.screen = 'title'; });
  await p.click('#btn-awards'); await p.waitForTimeout(300);
  check('each achievement earns a theme unlock', (await p.textContent('#styles-tokens')) === '剩余 2 次主题解锁');
  await p.click('#style-monokai'); await p.waitForTimeout(200);
  check('a locked theme unlocks for one token', await p.evaluate(() => SB.game.style === 'monokai' && SB.game.tokens() === 1));
  await p.screenshot({ path: OUT + '/flows-themes.png' });
  await p.keyboard.press('Escape');
  await p.keyboard.press('l');
  check('L toggles to light mode', await p.evaluate(() => SB.game.style === 'light_mode'));
  check('no page errors', errors.length === 0, errors.join(' | '));
});
