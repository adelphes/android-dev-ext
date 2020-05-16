const Declaration = require('./declaration');
const ParseProblem = require('./parse-problem');
const Token = require('./token');
const TypeParameters = require('./type-parameters');

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

    validate() {
        const checkModifierIsStatic = () => {
            if (this.static_ && this.static_.text !== 'static') {
                return ParseProblem.syntaxError(this.static_);
            }
        }

        const checkNoInvalidModifiers = () => {
            return this.modifiers.map(modifier => {
                if (modifier instanceof Token) {
                    return ParseProblem.syntaxError(modifier);
                }
                if (modifier instanceof TypeParameters) {
                    return ParseProblem.syntaxError(modifier.open);
                }
            })
        }

        /** @type {ParseProblem[]} */
        const problems = [
            checkModifierIsStatic(),
            ...ParseProblem.checkNonKeywordIdents(this.nameparts),
            ParseProblem.checkSemicolon(this),
            ...checkNoInvalidModifiers(),
        ];

        return problems;
    }
}

module.exports = ImportDeclaration;
