const os = require('os');
const uuid = require('uuid').v4;
let client;
/** @type {string} */
let uid;
/** @type {string} */
let did = uuid();
/** @type {number} */
let session_id;
/** @type {Map<string,[number,number]>} */
const timeLabels = new Map();
let session_start = Date.now();
/** @type {string|Promise<string>} */
let ip = '';
let queued_events = null;
let package_info = null;
let vscode_info = null;

/**
 * @param {string} [t] 
 * @param {string} u
 * @param {number} s
 * @param {string} ipaddr
 * @param {{name:string,version:string}} package_json
 * @param {*} vscode_props
 * @param {string} caller
 */
function init(t = '94635b4642d80407accd3739fa35bed6', u, s, ipaddr, package_json, vscode_props, caller) {
    if (client) {
        return;
    }
    try {
        client = require('@amplitude/node').init(t);
    }
    catch {
        return;
    }
    uid = u;
    session_id = s || Math.trunc(Math.random() * Number.MAX_SAFE_INTEGER);
    ip = ipaddr || (getCurrentIP()
        .catch(() => '')
        .then(res => ip = res));
    package_info = package_json;
    vscode_info = vscode_props;

    if (!caller) {
        return;
    }
    const now = new Date();
    event(caller, {
        extension: package_json.name,
        ext_version: package_json.version,
        arch: process.arch,
        cpus: os.cpus().length,
        mem: (os.totalmem() / 1e6)|0,
        platform: process.platform,
        node_version: process.version,
        release: os.release(),
        localtime: now.toTimeString(),
        tz: now.getTimezoneOffset(),
        ...vscode_props,
    });
}

function getCurrentIP() {
    return new Promise((resolve, reject) => {
        require('https').get(
            Buffer.from('aHR0cHM6Ly91YTF4c3JhM2ZhLmV4ZWN1dGUtYXBpLmV1LXdlc3QtMi5hbWF6b25hd3MuY29tL3JlbA==','base64').toString(),
            { headers: { 'Content-Type': 'application/json' } },
            res => resolve(res.headers['x-request-ip'])
        )
        .on('error', err => reject(err));
    })
}

/**
 * 
 * @param {string} eventName 
 * @param {*} [properties] 
 */
function event(eventName, properties) {
    if (!client || !eventName || (!uid && !did) || !ip) {
        return;
    }
    if (queued_events) {
        queued_events.push({eventName, properties});
        return;
    }
    if (ip instanceof Promise) {
        queued_events = [{eventName, properties}]
        ip.catch(() => {}).then(() => {
            const e = queued_events;
            queued_events = null;
            e.forEach(({eventName, properties}) => event(eventName, properties));
        });
        return;
    }
    try {
        /* client.logEvent */ let data = ({
            event_type: eventName,
            user_id: uid,
            device_id: uid ? undefined : did,
            app_version: package_info.version,
            ip,
            language: vscode_info.language,
            os_name: process.platform,
            os_version: os.release(),
            session_id,
            event_properties: {
                session_length: Math.trunc((Date.now() - session_start) / 60e3),
                ...properties,
            }
        });
        console.log('client.logEvent:', JSON.stringify(data, null, ' '));
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
            uid: '',
        };
    }
    let u = uid || (uid = context.globalState.get('mix-panel-id'));
    if (typeof u !== 'string' || u.length > 36) {
        u = uid = uuid();
        context.globalState.update('mix-panel-id', u);
    }
    return {
        uid: u,
    }
}
exports.init = init;
exports.event = event;
exports.time = time;
exports.timeEnd = timeEnd;
exports.getIDs = getIDs;
