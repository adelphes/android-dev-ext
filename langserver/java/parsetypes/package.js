const Declaration = require('./declaration');
const ParseProblem = require('./parse-problem');
/**
 * @typedef {import('./modifier')} Modifier
 * @typedef {import('./token')} Token
 */

class PackageDeclaration extends Declaration {
    /**
     * @param {Token} docs 
     * @param {Modifier[]} modifiers 
     * @param {Token[]} nameparts 
     * @param {Token} semicolon
     */
    constructor(docs, modifiers, nameparts, semicolon) {
        super(null, docs, modifiers);
        this.nameparts = nameparts;
        this.semicolon = semicolon;
    }

    dottedName() {
        return this.nameparts.map(t => t.text).join('.');
    }

    lastToken() {
        return this.semicolon || this.nameparts.slice(-1)[0];
    }

    validate() {
        /** @type {ParseProblem[]} */
        const problems = [
            ParseProblem.checkSemicolon(this),
            ...ParseProblem.checkNonKeywordIdents(this.nameparts),
        ];
        return problems;
    }
}

module.exports = PackageDeclaration;
