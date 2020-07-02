let mp;
/** @type {string} */
let uid;
/** @type {string} */
let sid;
/** @type {Map<string,[number,number]>} */
const timeLabels = new Map();
let session_start = Date.now();

/**
 * @param {string} t 
 * @param {string} u
 * @param {string} s
 * @param {{name:string,version:string}} package_json
 */
function init(t = '0cca95950055c6553804a46ce7e3df18', u, s, package_json, props) {
    if (mp) {
        return;
    }
    try {
        mp = require('mixpanel').init(t);
    }
    catch {}
    uid = u;
    sid = s;

    const os = require('os');
    event(`${package_json.name}-start`, {
        extension: package_json.name,
        ext_version: package_json.version,
        arch: process.arch,
        cpus: os.cpus().length,
        mem: (os.totalmem() / 1e6)|0,
        platform: process.platform,
        node_version: process.version,
        release: os.release(),
        ...props
    });
}

/**
 * 
 * @param {string} eventName 
 * @param {*} [properties] 
 */
function event(eventName, properties) {
    if (!mp) {
        return;
    }
    try {
        if (uid) {
            mp.track(eventName, {
                distinct_id: uid,
                session_id: sid,
                session_length: Math.trunc((Date.now() - session_start) / 60e3),
                ...properties,
            });
        } else {
            mp.track(eventName);
        }
    } catch {}
}

/**
 * @param {string} label 
 */
function time(label) {
    if (!label || timeLabels.has(label)) {
        return;
    }
    timeLabels.set(label, process.hrtime());
}

/**
 * @param {string} label 
 * @param {'ns'|'us'|'ms'|'s'} time_unit
 * @param {*} [additionalProps]
 */
function timeEnd(label, time_unit = 'ms', additionalProps = {}) {
    if (!label) {
        return;
    }
    const startTime = timeLabels.get(label);
    timeLabels.delete(label);
    if (!Array.isArray(startTime)) {
        return;
    }
    const elapsed = process.hrtime(startTime);
    const count = time_unit === 's' ? elapsed[0] : ((elapsed[0]*1e9) + elapsed[1]);
    const divs = {
        ns: 1, us: 1e3, ms: 1e6, s: 1
    }
    const props = {
        [`${label}-elapsed`]: Math.trunc(count / (divs[time_unit] || 1)),
        [`${label}-elapsed_unit`]: time_unit,
        ...additionalProps,
    }
    event(label, props);
}

/**
 * @param {import('vscode').ExtensionContext} context
 */
function getIDs(context) {
    if (!context || !context.globalState) {
        return {
            uid: '', sid: ''
        };
    }
    let uuidv4 = () => {
        try {
            uuidv4 = require('uuid').v4;
            return uuidv4();
        } catch {
            return '';
        }
    }
    let u = uid || (uid = context.globalState.get('mix-panel-id'));
    if (typeof u !== 'string' || u.length > 36) {
        u = uid = uuidv4();
        context.globalState.update('mix-panel-id', u);
    }
    let s = sid || (sid = uuidv4());
    return {
        uid: u,
        sid: s,
    }
}

exports.init = init;
exports.event = event;
exports.time = time;
exports.timeEnd = timeEnd;
exports.getIDs = getIDs;
