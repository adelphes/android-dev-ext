const { parse } = require('./java/body-parser');
const { parseMethodBodies } = require('./java/validater');
const { time, timeEnd, trace } = require('./logging');

/**
 * @typedef {import('java-mti').CEIType} CEIType
 * @typedef {import('./java/source-types').SourceUnit} SourceUnit
 */

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
    if (!Array.isArray(uris)) {
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

exports.indexAt = indexAt;
exports.positionAt = positionAt;
exports.FileURIMap = FileURIMap;
exports.JavaDocInfo = JavaDocInfo;
exports.ParsedInfo = ParsedInfo;
exports.reparse = reparse;
