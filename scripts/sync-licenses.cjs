const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dest = path.join(root, 'third_party', 'licenses');
fs.mkdirSync(dest, { recursive: true });
for (const [pkg, license] of [['electron', 'LICENSE'], ['katex', 'LICENSE'], ['koffi', 'LICENSE.txt'], ['opencc-js', 'LICENSE']]) {
  fs.copyFileSync(path.join(root, 'app', 'node_modules', pkg, license), path.join(dest, `${pkg}-LICENSE.txt`));
}
fs.copyFileSync(path.join(root, 'app/node_modules/opencc-js/THIRD_PARTY_LICENSES.md'), path.join(dest, 'opencc-js-THIRD_PARTY_LICENSES.md'));
fs.cpSync(path.join(root, 'app/node_modules/opencc-js/LICENSES'), path.join(dest, 'opencc-js-data'), { recursive: true });
fs.copyFileSync(path.join(root, 'app/node_modules/electron/dist/LICENSES.chromium.html'), path.join(dest, 'Electron-LICENSES.chromium.html'));
console.log('Runtime license notices synchronized from installed packages.');
