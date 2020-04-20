/**
 * Returns a Promise which resolves after the specified period.
 * @param {number} ms wait time in milliseconds
 */
function sleep(ms) {
	return new Promise(r => setTimeout(r, ms));
}

module.exports = {
    sleep,
}
