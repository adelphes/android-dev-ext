const Declaration = require('./declaration');
const Token = require('./token');

/**
 * @typedef {import('./modifier')} Modifier
 */

class ImportDeclaration extends Declaration {
    /**
     * @param {Token} docs 
     * @param {Modifier[]} modifiers 
     * @param {Token[]} nameparts 
     * @param {Token} static_
     * @param {Token} asterisk
     * @param {Token} semicolon
     */
    constructor(docs, modifiers, nameparts, static_, asterisk, semicolon) {
        super(null, docs, modifiers);
        this.nameparts = nameparts;
        this.static_ = static_;
        this.asterisk = asterisk;
        this.semicolon = semicolon;
    }

    /**
     * Returns the dotted portion of the import declaration (excluding any demand-load part)
     */
    getDottedName() {
        return this.nameparts.map(x => x.text).join('.');
    }

    lastToken() {
        return this.semicolon || this.asterisk || this.nameparts.slice(-1)[0];
    }
}

module.exports = ImportDeclaration;
