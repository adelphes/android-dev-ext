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
 * initial source file load (we cannot accurately parse individual files until we
 * know what all the types are - hence the need to perform a first parse of all the source files).
 * 
 * While we are waiting for the first parse to complete, individual files-to-parse are added
 * to this set. Once the first scan and parse is done, these are reparsed and
 * first_parse_waiting is set to `null`.
 * @type {Set<string>}
 */
let first_parse_waiting = new Set();

/**
 * Convert a line,character position to an absolute character offset
 * 
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
 * Convert an absolute character offset to a line,character position
 * 
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

/**
 * A specialised Map to allow for case-insensitive fileURIs on Windows.
 * 
 * For cs-filesystems, this should work as a normal map.
 * For ci-filesystems, if a file URI case changes, it should be picked up
 * by the lowercase map
 */
class FileURIMap extends Map {
    lowerMap = new Map();

    /**
     * @param {string} key 
     */
    get(key) {
        return super.get(key) || this.lowerMap.get(key.toLowerCase());
    }

    /**
     * @param {string} key 
     */
    has(key) {
        return super.has(key) || this.lowerMap.has(key.toLowerCase());
    }

    /**
     * @param {string} key 
     * @param {*} value 
     */
    set(key, value) {
        super.set(key, value);
        this.lowerMap.set(key.toLowerCase(), value);
        return this;
    }

    /**
     * @param {string} key 
     */
    delete(key) {
        this.lowerMap.delete(key.toLowerCase());
        return super.delete(key);
    }

    clear() {
        super.clear();
        this.lowerMap.clear();
    }
}

/**
 * Class for storing data about Java source files
 */
class JavaDocInfo {
     /**
      * @param {string} uri the file URI
      * @param {string} content the full file content
      * @param {number} version revision number for edited files (each edit increments the version)
      */
     constructor(uri, content, version) {
         this.uri = uri;
         this.content = content;
         this.version = version;
         /** 
          * The result of the Java parse
          * @type {ParsedInfo}
          */
         this.parsed = null;
         
         /**
          * Promise linked to a timer which resolves a short time after the user stops typing
          * - This is used to prevent constant reparsing while the user is typing in the document
          * @type {Promise}
          */
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
      * A `reparseWaiter` promise is used to delay actions like completion items
      * retrieval and method signature resolving until the reparse is complete.
      * 
      * @param {Map<string,JavaDocInfo>} liveParsers 
      * @param {Map<string,CEIType>|Promise<Map<string,CEIType>>} androidLibrary 
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

/**
 * Result from parsing a Java file
 */
class ParsedInfo {
    /**
     * @param {string} uri the file URI
     * @param {string} content the full file content
     * @param {number} version the version this parse applies to
     * @param {Map<string,CEIType>} typemap the set of known types
     * @param {SourceUnit} unit the parsed unit
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
 * @param {Map<string, JavaDocInfo>} liveParsers
 * @param {Map<string,CEIType>|Promise<Map<string,CEIType>>} androidLibrary
 * @param {{includeMethods: boolean, first_parse?: boolean}} [opts]
 */
function reparse(uris, liveParsers, androidLibrary, opts) {
    trace(`reparse`);
    // we must have at least one URI
    if (!uris || !uris.length) {
        return;
    }
    if (first_parse_waiting) {
        if (!opts || !opts.first_parse) {
            // we are waiting for the first parse to complete - add this file to the list
            uris.forEach(uri => first_parse_waiting.add(uri));
            trace('waiting for first parse')
            return;
        }
    }

    if (androidLibrary instanceof Promise) {
        // reparse after the library has finished loading
        androidLibrary.then(lib => reparse(uris, liveParsers, lib, opts));
        return;
    }

    const cached_units = [], parsers = [];
    for (let docinfo of liveParsers.values()) {
        if (uris.includes(docinfo.uri)) {
            // make a copy of the content + version in case the source file is edited while we're parsing
            parsers.push({uri: docinfo.uri, content: docinfo.content, version: docinfo.version});
        } else if (docinfo.parsed) {
            cached_units.push(docinfo.parsed.unit);
        }
    }
    if (!parsers.length) {
        return;
    }

    // Each parse uses a unique typemap, initialised from the android library
    const typemap = new Map(androidLibrary);

    // perform the parse
    const units = parse(parsers, cached_units, typemap);

    // create new ParsedInfo instances for each of the parsed units
    units.forEach(unit => {
        const parser = parsers.find(p => p.uri === unit.uri);
        if (!parser) return;
        const doc = liveParsers.get(unit.uri);
        if (!doc) return;
        doc.parsed = new ParsedInfo(doc.uri, parser.content, parser.version, typemap, unit, []);
    });

    let method_body_uris = [];
    if (first_parse_waiting) {
        // this is the first parse - parse the bodies of any waiting URIs and
        // set first_parse_waiting to null
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
 * Called during initialization and whenever the App Source Root setting is changed to scan
 * for source files
 * 
 * @param {string} src_folder absolute path to the source root
 * @param {Map<string,JavaDocInfo>} liveParsers
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
            // read the full file content
            const file_content = await new Promise((res, rej) => fs.readFile(file.fpn, 'UTF8', (err,data) => err ? rej(err) : res(data)));
            // construct a new JavaDoc instance for the source file
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
exports.FileURIMap = FileURIMap;
exports.JavaDocInfo = JavaDocInfo;
exports.ParsedInfo = ParsedInfo;
exports.reparse = reparse;
exports.getAppSourceRootFolder = getAppSourceRootFolder;
exports.rescanSourceFolders = rescanSourceFolders;