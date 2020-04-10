const fs = require('fs');

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

/**
 * Adds a callback to be called when any message is output
 * @param {Function} cb 
 */
function onMessagePrint(cb) {
    messagePrintCallbacks.add(cb);
}

/**
 * Returns true if the parameter is an object with no members
 * @param {*} o 
 */
function isEmptyObject(o) {
	return typeof (o) === 'object' && !Object.keys(o).length;
}

/**
 * Convert a number to a hex string, zero-padded to a minimum length
 * @param {number} i number to convert
 * @param {number} minlen minimum length of resulting string
 */
function intToHex(i, minlen) {
	return i.toString(16).padStart(minlen, '0');
}

/**
 * Promisified fs.readFile()
 * @param {string} path 
 * @param {*} [options] 
 */
function readFile(path, options) {
	return new Promise((res, rej) => {
		fs.readFile(path, options || {}, (err, data) => {
			err ? rej(err) : res(data);
		})
	})
}

module.exports = {
	D,
	E,
	intToHex,
	isEmptyObject,
	onMessagePrint,
	readFile,
	W,
}
