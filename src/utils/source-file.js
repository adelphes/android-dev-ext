/**
 * Returns true if the string has an extension we recognise as a source file
 * @param {string} s 
 */
function hasValidSourceFileExtension(s) {
	return /\.(java|kt)$/i.test(s);
}

function splitSourcePath(filepath) {
    const m = filepath.match(/^\/([^/]+(?:\/[^/]+)*)?\/([^./]+)\.(java|kt)$/);
    return {
        pkg: m[1].replace(/\/+/g, '.'),
        type: m[2],
        qtype: `${m[1]}/${m[2]}`,
    }
}

module.exports = {
    hasValidSourceFileExtension,
    splitSourcePath,
}
