/**
 * Set of callbacks to be called when any message is output to the console
 * @type {Set<Function>}
 * */
const messagePrintCallbacks = new Set();

function callMessagePrintCallbacks(args) {
	messagePrintCallbacks.forEach(cb => cb(...args));
}

/**
 * print a debug message to the console
 * @param  {...any} args 
 */
function D(...args) {
	console.log(...args);
	callMessagePrintCallbacks(args);
}

/**
 * print an error message to the console
 * @param  {...any} args 
 */
function E(...args) {
	console.error(...args);
	callMessagePrintCallbacks(args);
}

/**
 * print a warning message to the console
 * @param  {...any} args 
 */
function W(...args) {
	console.warn(...args);
	callMessagePrintCallbacks(args);
}

let printLogToClient;
function initLogToClient(fn) {
	printLogToClient = fn;
}

/**
 * Print a log message
 * @param {*} msg 
 */
function LOG(msg) {
	if (printLogToClient) {
		printLogToClient(msg);
	} else {
		D(msg);
	}
}

/**
 * Adds a callback to be called when any message is output
 * @param {Function} cb 
 */
function onMessagePrint(cb) {
    messagePrintCallbacks.add(cb);
}

module.exports = {
    D,
	E,
	initLogToClient,
	LOG,
    W,
    onMessagePrint,
}
