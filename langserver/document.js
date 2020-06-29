const fs = require('fs');
const path = require('path');
const os = require('os');
const { CEIType } = require('java-mti');
const { Settings } = require('./settings');
const ParseProblem = require('./java/parsetypes/parse-problem');
const { parse } = require('./java/body-parser');
const { SourceUnit } = require('./java/source-types');
const { parseMethodBodies } = require('./java/validater');
const { time, timeEnd, trace } = require('./logging');

/**
 * Marker to prevent early parsing of source files before we've completed our
 * initial source file load
 * @type {Set<string>}
 */
let first_parse_waiting = new Set();

/**
 * @param {{line:number,character:number}} pos 
 * @param {string} content 
 */
function indexAt(pos, content) {
    let idx = 0;
    for (let i = 0; i < pos.line; i++) {
        idx = content.indexOf('\n', idx) + 1;
        if (idx === 0) {
            return content.length;
        }
    }
    return Math.min(idx + pos.character, content.length);
}

/**
 * @param {number} index 
 * @param {string} content 
 */
function positionAt(index, content) {
    let line = 0,
        last_nl_idx = 0,
        character = 0;
    if (index <= 0) return { line, character };
    for (let idx = 0; ;) {
        idx = content.indexOf('\n', idx) + 1;
        if (idx === 0 || idx > index) {
            if (idx === 0) index = content.length;
            character = index - last_nl_idx;
            return { line, character };
        }
        last_nl_idx = idx;
        line++;
    }
}

class JavaDocInfo {
     /**
      * @param {string} uri 
      * @param {string} content 
      * @param {number} version 
      */
     constructor(uri, content, version) {
         this.uri = uri;
         this.content = content;
         this.version = version;
         /** @type {ParsedInfo} */
         this.parsed = null;
         /** @type {Promise} */
         this.reparseWaiter = Promise.resolve();
         /** @type {{ resolve: () => void, timer: * }} */
         this.waitInfo = null;
     }

     /**
      * Schedule this document for reparsing.
      * 
      * To prevent redundant parsing while typing, a small delay is required 
      * before the reparse happens.
      * When a key is pressed, `scheduleReparse()` starts a timer. If more
      * keys are typed before the timer expires, the timer is restarted.
      * Once typing pauses, the timer expires and the content reparsed.
      * 
      * A `reparseWaiter` promise is used to delay the completion items
      * retrieval until the reparse is complete.
      * 
      * @param {*} liveParsers 
      * @param {*} androidLibrary 
      */
     scheduleReparse(liveParsers, androidLibrary) {
        const createWaitTimer = () => {
            return setTimeout(() => {
                // reparse the content, resolve the reparseWaiter promise
                // and reset the fields
                reparse([this.uri], liveParsers, androidLibrary, { includeMethods: true });
                this.waitInfo.resolve();
                this.waitInfo = null;
            }, 250);
         }
         if (this.waitInfo) {
             // we already have a promise pending - just restart the timer
             trace('restart timer');
             clearTimeout(this.waitInfo.timer);
             this.waitInfo.timer = createWaitTimer();
             return;
         }
         // create a new pending promise and start the timer
         trace('start timer');
         this.waitInfo = {
            resolve: null,
            timer: createWaitTimer(),
        }
        this.reparseWaiter = new Promise(resolve => this.waitInfo.resolve = resolve);
    }
}

class ParsedInfo {
    /**
     * @param {string} uri 
     * @param {string} content 
     * @param {number} version 
     * @param {Map<string,CEIType>} typemap 
     * @param {SourceUnit} unit 
     * @param {ParseProblem[]} problems 
     */
    constructor(uri, content, version, typemap, unit, problems) {
        this.uri = uri;
        this.content = content;
        this.version = version;
        this.typemap = typemap;
        this.unit = unit;
        this.problems = problems;
    }
}

/**
 * @param {string[]} uris
 * @param {*} liveParsers
 * @param {*} androidLibrary
 * @param {{includeMethods: boolean, first_parse?: boolean}} [opts]
 */
function reparse(uris, liveParsers, androidLibrary, opts) {
    trace(`reparse`);
    if (!uris || !uris.length) {
        return;
    }
    if (first_parse_waiting) {
        if (!opts || !opts.first_parse) {
            uris.forEach(uri => first_parse_waiting.add(uri));
            trace('waiting for first parse')
            return;
        }
    }
    if (androidLibrary instanceof Promise) {
        // reparse after the library has loaded
        androidLibrary.then(lib => reparse(uris, liveParsers, lib, opts));
        return;
    }
    const cached_units = [], parsers = [];
    for (let docinfo of liveParsers.values()) {
        if (uris.includes(docinfo.uri)) {
            // make a copy of the content in case doc changes while we're parsing
            parsers.push({uri: docinfo.uri, content: docinfo.content, version: docinfo.version});
        } else if (docinfo.parsed) {
            cached_units.push(docinfo.parsed.unit);
        }
    }
    if (!parsers.length) {
        return;
    }

    const typemap = new Map(androidLibrary);
    const units = parse(parsers, cached_units, typemap);

    units.forEach(unit => {
        const parser = parsers.find(p => p.uri === unit.uri);
        if (!parser) return;
        const doc = liveParsers.get(unit.uri);
        if (!doc) return;
        doc.parsed = new ParsedInfo(doc.uri, parser.content, parser.version, typemap, unit, []);
    });

    let method_body_uris = [];
    if (first_parse_waiting) {
        // this is the first parse - parse the bodies of any waiting
        method_body_uris = [...first_parse_waiting];
        first_parse_waiting = null;
    }

    if (opts && opts.includeMethods) {
        method_body_uris = uris;
    }

    if (method_body_uris.length) {
        time('parse-methods');
        method_body_uris.forEach(uri => {
            const doc = liveParsers.get(uri);
            if (!doc || !doc.parsed) {
                return;
            }
            parseMethodBodies(doc.parsed.unit, typemap);
        })
        timeEnd('parse-methods');
    }
}

/**
 * Called during initialization and whenver the App Source Root setting is changed to scan
 * for source files
 * @param {string} src_folder absolute path to the source root
 * @param {*} liveParsers
 */
async function rescanSourceFolders(src_folder, liveParsers) {
    if (!src_folder) {
        return;
    }

    // when the appSourceRoot config value changes and we rescan the folder, we need
    // to delete any parsers that were from the old appSourceRoot
    const unused_keys = new Set(liveParsers.keys());

    const files = await loadWorkingFileList(src_folder);

    // create live parsers for all the java files, but don't replace any existing ones which
    // have been loaded (and may be edited) before we reach here
    for (let file of files) {
        if (!/\.java$/i.test(file.fpn)) {
            continue;
        }
        const uri = `file://${file.fpn}`;    // todo - handle case-differences on Windows
        unused_keys.delete(uri);

        if (liveParsers.has(uri)) {
            trace(`already loaded: ${uri}`);
            continue;
        }

        try {
            const file_content = await new Promise((res, rej) => fs.readFile(file.fpn, 'UTF8', (err,data) => err ? rej(err) : res(data)));
            liveParsers.set(uri, new JavaDocInfo(uri, file_content, 0));
        } catch {}
    }

    // remove any parsers that are no longer part of the working set
    unused_keys.forEach(uri => liveParsers.delete(uri));
}

/**
 * Attempts to locate the app root folder using workspace folders and the appSourceRoot setting
 * @param {*} workspace
 * @returns Absolute path to app root folder or null
 */
async function getAppSourceRootFolder(workspace) {
    /** @type {string} */
    let src_folder = null;

    const folders = await workspace.getWorkspaceFolders();
    if (!folders || !folders.length) {
        trace('No workspace folders');
        return src_folder;
    }

    folders.find(folder => {
        const main_folder = path.join(folder.uri.replace(/^\w+:\/\//, ''), Settings.appSourceRoot);
        try {
            if (fs.statSync(main_folder).isDirectory()) {
                src_folder = main_folder;
                return true;
            }
        } catch {}
    });

    if (!src_folder) {
        console.log([
            `Failed to find source root from workspace folders:`,
            ...folders.map(f => ` - ${f.uri}`),
            'Configure the Android App Source Root value in your workspace settings to point to your source folder containing AndroidManifest.xml',
        ].join(os.EOL));
    }

    return src_folder;
}

async function loadWorkingFileList(src_folder) {
    if (!src_folder) {
        return [];
    }

    trace(`Using src root folder: ${src_folder}. Searching for Android project source files...`);
    time('source file search')
    const files = scanSourceFiles(src_folder);
    timeEnd('source file search');

    if (!files.find(file => /^androidmanifest.xml$/i.test(file.relfpn))) {
        console.log(`Warning: No AndroidManifest.xml found in app root folder. Check the Android App Source Root value in your workspace settings.`)
    }

    return files;

    /**
     * @param {string} base_folder 
     * @returns {{fpn:string, relfpn: string, stat:fs.Stats}[]}
     */
    function scanSourceFiles(base_folder) {
        // strip any trailing slash
        base_folder = base_folder.replace(/[\\/]+$/, '');
        const done = new Set(), folders = [base_folder], files = [];
        const max_folders = 100;
        while (folders.length) {
            const folder = folders.shift();
            if (done.has(folder)) {
                continue;
            }
            done.add(folder);
            if (done.size > max_folders) {
                console.log(`Max folder limit reached - cancelling file search`);
                break;
            }
            try {
                trace(`scan source folder ${folder}`)
                fs.readdirSync(folder)
                    .forEach(name => {
                        const fpn = path.join(folder, name);
                        const stat = fs.statSync(fpn);
                        files.push({
                            fpn,
                            // relative path (without leading slash)
                            relfpn: fpn.slice(base_folder.length + 1),
                            stat,
                        });
                        if (stat.isDirectory()) {
                            folders.push(fpn)
                        }
                    });
            } catch (err) {
                trace(`Failed to scan source folder ${folder}: ${err.message}`)
            }
        }
        return files;
    }
}

exports.indexAt = indexAt;
exports.positionAt = positionAt;
exports.JavaDocInfo = JavaDocInfo;
exports.ParsedInfo = ParsedInfo;
exports.reparse = reparse;
exports.getAppSourceRootFolder = getAppSourceRootFolder;
exports.rescanSourceFolders = rescanSourceFolders;