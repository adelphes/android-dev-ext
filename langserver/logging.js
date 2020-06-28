const { Settings } = require('./settings');

const earlyTraceBuffer = [];

/**
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

function time(label) {
    if (Settings.trace) {
        console.time(label);
    }
}

function timeEnd(label) {
    if (Settings.trace) {
        console.timeEnd(label);
    }
}

exports.info = info;
exports.trace = trace;
exports.time = time;
exports.timeEnd = timeEnd;
