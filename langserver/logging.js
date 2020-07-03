const { Settings } = require('./settings');

const earlyTraceBuffer = [];

/**
 * Log a trace message with a timestamp - only logs if "Trace enabled" in settings
 * @param {string} s 
 */
function trace(s) {
    if (Settings.updateCount > 0 && !Settings.trace) {
        return;
    }
    const msg = `${Date.now()}: ${s}`;
    // before we've retrieved the trace setting, buffer the messages
    if (Settings.updateCount === 0) {
        earlyTraceBuffer.push(msg);
        return;
    }
    if (earlyTraceBuffer.length) {
        earlyTraceBuffer.splice(0, earlyTraceBuffer.length).forEach(msg => console.log(msg));
    }
    console.log(msg);
}

function info(msg) {
    console.log(msg);
}

/**
 * Set of active timers
 * @type {Set<string>}
 */
const timersRunning = new Set();

/**
 * Starts a named timer using `console.time()` - only if "Trace Enabled" in Settings
 * @param {string} label 
 */
function time(label) {
    if (Settings.trace) {
        timersRunning.add(label);
        console.time(label);
    }
}

/**
 * Stops a named timer (and prints the elapsed time) using `console.timeEnd()`
 * @param {string} label 
 */
function timeEnd(label) {
    if (timersRunning.has(label)) {
        timersRunning.delete(label);
        console.timeEnd(label);
    }
}

exports.info = info;
exports.trace = trace;
exports.time = time;
exports.timeEnd = timeEnd;
