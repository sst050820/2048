// Loads the browser rules and physics into Node: `const SB = require('./harness')`.
global.window = global;
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..', 'www', 'js');
for (const f of process.env.SB_FILES ? process.env.SB_FILES.split(',') : ['physics.js', 'mode.js', 'achievements.js', 'styles.js']) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(root, f), 'utf8'));
}
module.exports = global.SB;
