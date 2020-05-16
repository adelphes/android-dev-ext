/**
 * @typedef {import('./token')} Token
 * @typedef {import('./resolved-type')} ResolvedType
 */

/**
 * Class to represent a declared type in methods, fields, parameters and variables
 */
class TypeIdent {
    /**
     * @param {Token[]} tokens 
     */
    constructor(tokens) {
        this.tokens = tokens;
        /** @type {ResolvedType} */
        this.resolved = null;
    }

    lastToken() {
        return this.tokens[this.tokens.length - 1];
    }
}

module.exports = TypeIdent;
