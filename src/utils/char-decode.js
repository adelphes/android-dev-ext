const BACKSLASH_ESCAPE_MAP = {
    b: '\b',
    f: '\f',
    r: '\r',
    n: '\n',
    t: '\t',
    v: '\v',
    '0': '\0',
    '\\': '\\',
};

/**
 * De-escape backslash escaped characters
 * @param {string} c 
 */
function decode_char(c) {
    switch(true) {
        case /^\\u[0-9a-fA-F]{4}$/.test(c):
            // unicode escape
            return String.fromCharCode(parseInt(c.slice(2),16));

        case /^\\.$/.test(c):
            // backslash escape
            const char = BACKSLASH_ESCAPE_MAP[c[1]];
            return char || c[1];

        case c.length === 1: 
            return c;
    }
    throw new Error('Invalid character value');
}

/**
 * Convert a Java string literal to a raw string
 * @param {string} s 
 */
function decodeJavaStringLiteral(s) {
    return s.slice(1, -1).replace(/\\u[0-9a-fA-F]{4}|\\./g, decode_char);
}

/**
 * Convert a Java char literal to a raw character
 * @param {string} s 
 */
function decodeJavaCharLiteral(s) {
    return decode_char(s.slice(1, -1));
}

module.exports = {
    decode_char,
    decodeJavaCharLiteral,
    decodeJavaStringLiteral,
}
