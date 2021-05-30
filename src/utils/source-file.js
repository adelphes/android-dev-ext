/**
 * Returns true if the string has an extension we recognise as a source file
 * @param {string} s 
 */
function hasValidSourceFileExtension(s) {
	return /\.(java|kt)$/i.test(s);
}

/**
 * @param {string} filepath 
 */
function splitSourcePath(filepath) {
    const m = filepath.match(/^\/([^/]+(?:\/[^/]+)*)?\/([^./]+)\.(java|kt)$/i);
    return {
        pkg: m[1].replace(/\/+/g, '.'),
        type: m[2],
        qtype: `${m[1]}/${m[2]}`,
        file: `${m[2]}.${m[3]}`,
    }
}

module.exports = {
    hasValidSourceFileExtension,
    splitSourcePath,
}
