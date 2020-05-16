const Declaration = require('./declaration');

/**
 * @typedef {import('./modifier')} Modifier
 * @typedef {import('./typeident')} TypeIdent
 * @typedef {import('./token')} Token
 */

 /**
  * A single parameter declaration
  */
 class ParameterDeclaration extends Declaration {
    /**
     * @param {Modifier[]} modifiers 
     * @param {TypeIdent} type 
     * @param {Token} varargs 
     * @param {Token} name 
     * @param {Token} comma
     */
    constructor(modifiers, type, varargs, name, comma) {
        super(null, null, modifiers);
        this.name = name;
        this.type = type;
        this.varargs = varargs;
        this.comma = comma;
    }

    lastToken() {
        return this.comma || this.name;
    }
}

module.exports = ParameterDeclaration;
