/**
 * This is a really basic module packer. It simply loads all the modules into a
 * single object, appends a simple bootstrap require function to 'load' the modules at
 * runtime and then writes the result out to a entry module.
 * 
 * - Each local module (i.e not in node_modules) must be a relative path starting with . or ..
 * - Subfolders are allowed, but only js files are included.
 */

/** These are the sources (files and folders) we want to pack */
const sources = [
    'completions.js',
    'doc-formatter.js',
    'document.js',
    'java',
    'logging.js',
    'method-signatures.js',
    'server.js',
    'settings.js'
]

/** The entry module - must have a relative path */
const entry = './server.js';

const fs = require('fs');
const modules = [];

while (sources.length) {
    const source = sources.shift();
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
        fs.readdirSync(source).forEach(entry => {
            sources.unshift(`${source}/${entry}`);
        })
        continue;
    }
    if (!source.endsWith('.js')) {
        console.log(`ignoring non-js file: ${source}`);
        continue;
    }
    // add an object entry of the form: 'path': (...) => { file_content }
    modules.push(`'${source}':
(require,module,exports) => {
${fs.readFileSync(source, 'utf8')}
}`
    );
}

/**
 * The bootstrap contains the custom require function and the call to load
 * the initial module - it's everything after the marker below
 */
const bootstrap = fs.readFileSync(__filename, 'utf8').split('/* bootstrap marker */').pop();

fs.writeFileSync(entry,
`const data = {
${modules.join(',\n')}
}
${bootstrap}
_require('${entry}');
`);

/* bootstrap marker */

const module_stack = [{
    path: [],
    name: '',
}]

const loadedModules = new Set();

function _require(filename) {
    // local modules always have a relative path
    if (!filename.startsWith('.')) {
        // node_modules import
        return require(filename);
    }
    const new_path = module_stack[0].path.slice();
    let key = filename.replace(/(\.js)?$/, '.js');
    for (let m; m = key.match(/^\.\.?\//);) {
        key = key.slice(m[0].length);
        if (m[0] === '../') {
            new_path.pop();
        }
    }
    key = [...new_path, key].join('/');

    if (!Object.prototype.hasOwnProperty.call(data, key)) {
        throw new Error(`Missing module: ${key}`);
    }

    const entry = data[key];

    if (loadedModules.has(key)) {
        return entry;
    }

    const path_parts = key.split(/[\\/]/);

    module_stack.unshift({
        name: path_parts.pop(),
        path: path_parts,
    })
    const mod = {
        exports: {},
    }
    entry(_require, mod, mod.exports);
    module_stack.shift();

    loadedModules.add(key);
    return data[key] = mod.exports;
}
