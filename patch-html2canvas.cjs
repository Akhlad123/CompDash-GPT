const fs = require('fs');
const file = 'node_modules/html2canvas/dist/html2canvas.js';
let src = fs.readFileSync(file, 'utf8');
const re = /if\s*\(typeof colorFunction === 'undefined'\)\s*\{\s*throw new Error\([^)]+\);\s*\}/;
if (re.test(src)) {
  src = src.replace(re, "if (typeof colorFunction === 'undefined') { return 0; }");
  fs.writeFileSync(file, src);
  console.log('html2canvas patched: unsupported color functions now return transparent.');
} else {
  console.log('html2canvas already patched or pattern not found.');
}
