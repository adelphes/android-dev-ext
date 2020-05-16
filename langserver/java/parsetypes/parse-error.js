const Declaration = require('./declaration');
const ParseProblem = require('./parse-problem');
/**
 * @typedef {import('./modifier')} Modifier
 * @typedef {import('./token')} Token
 */

class ParseSyntaxError extends Declaration {
    /**
     * @param {Token} docs 
     * @param {Modifier[]} modifiers 
     * @param {Token} errorToken 
     */
    constructor(docs, modifiers, errorToken) {
        super(null, docs, modifiers);
        this.errorToken = errorToken;
    }

    validate() {
        if (!this.errorToken) {
            return [];
        }
        return [
            ParseProblem.syntaxError(this.errorToken),
        ]
    }
}

module.exports = ParseSyntaxError;
